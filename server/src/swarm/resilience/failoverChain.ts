// R1 + R3: provider-failover decision + graceful degradation.
// Pure decision functions — no I/O.

import type { ClassifiedError, FailoverAction, FailoverDecision, FailoverInput, FailoverConfig, PromptWithRetryOptions, AttemptRecord } from "./types.js";
import { classifyError } from "./errorTaxonomy.js";
import { detectProvider } from "@ollama-swarm/shared/providers";
import { evaluateModelHealth } from "./healthTracker.js";
import { trimAttemptWindow } from "./healthTracker.js";
import { promptWithRetry as defaultPromptWithRetry } from "../promptWithRetry.js";
import { interruptibleSleep } from "../interruptibleSleep.js";

export function decideFailover(input: FailoverInput): FailoverDecision {
  const { currentModel, classified, failoverChain, alreadyTried } = input;

  if (
    classified.category === "cap" ||
    classified.category === "user-stop" ||
    classified.category === "runner-bug"
  ) {
    return {
      action: "give-up",
      reason: `terminal category ${classified.category} — failover skipped`,
    };
  }

  if (classified.category === "disk" || classified.category === "oom") {
    return {
      action: "give-up",
      reason: `local-machine failure (${classified.category}) — swap won't help`,
    };
  }

  if (classified.category === "quota" || classified.category === "auth") {
    const next = pickNextUntried(currentModel, failoverChain, alreadyTried);
    if (next) {
      return {
        action: "swap",
        nextModel: next,
        reason: `${classified.category} on ${currentModel} → swap to ${next}`,
      };
    }
    return {
      action: "give-up",
      reason: `${classified.category} on ${currentModel} but failover chain exhausted`,
    };
  }

  // model-output already exhausted same-model retries inside promptWithRetry.
  // Prefer swap (providerFailover) over "retry-same" which the loop would rethrow.
  // Run 961a885f: think-only / json sniff on deepseek with empty chain → crash;
  // with a configured chain, format failures must try the next model.
  if (classified.category === "model-output") {
    const next = pickNextUntried(currentModel, failoverChain, alreadyTried);
    if (next) {
      return {
        action: "swap",
        nextModel: next,
        reason: `model-output on ${currentModel} → swap to ${next}`,
      };
    }
    return {
      action: "give-up",
      reason: `model-output on ${currentModel} and no failover model in chain`,
    };
  }

  if (classified.retryable) {
    return {
      action: "retry-same",
      reason: `${classified.category} is transient on ${currentModel} — retry`,
    };
  }

  const next = pickNextUntried(currentModel, failoverChain, alreadyTried);
  if (next) {
    return {
      action: "swap",
      nextModel: next,
      reason: `non-retryable ${classified.category} — try ${next}`,
    };
  }
  return {
    action: "give-up",
    reason: `non-retryable ${classified.category} and no fallback available`,
  };
}

function pickNextUntried(
  currentModel: string,
  chain: readonly string[],
  alreadyTried: ReadonlySet<string>,
): string | null {
  for (const candidate of chain) {
    if (candidate === currentModel) continue;
    if (alreadyTried.has(candidate)) continue;
    return candidate;
  }
  return null;
}

// R3: graceful degradation from cloud → local model.
export function isCloudModel(modelString: string): boolean {
  const provider = detectProvider(modelString);
  return provider !== "ollama";
}

export function pickLocalFallback(input: {
  failedModel: string;
  localTags: readonly string[];
  preferred?: readonly string[];
}): string | null {
  const { failedModel, localTags, preferred = [] } = input;
  if (localTags.length === 0) return null;

  const candidates = localTags.filter((t) => t !== failedModel);
  if (candidates.length === 0) return null;

  for (const p of preferred) {
    if (candidates.includes(p)) return p;
  }

  const ranked = [...candidates].sort((a, b) => {
    const sa = inferParamSize(a);
    const sb = inferParamSize(b);
    if (sb !== sa) return sb - sa;
    return a.localeCompare(b);
  });
  return ranked[0] ?? null;
}

export function inferParamSize(tag: string): number {
  const m = tag.match(/(\d+(?:\.\d+)?)([bm])\b/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return m[2].toLowerCase() === "b" ? n : n / 1000;
}

// Main failover loop with R1 + R3 + R10.
const DEFAULT_MAX_SWAPS = 3;
const UNKNOWN_ERROR_RETRY_BACKOFF_MS = 5_000;

export async function promptWithFailover<TAgent>(
  agent: TAgent,
  promptText: string,
  baseOpts: PromptWithRetryOptions,
  state: { modelHealth: Map<string, AttemptRecord[]> },
  cfg: FailoverConfig,
  onFailover?: (info: {
    fromModel: string;
    toModel: string;
    classified: ClassifiedError;
    reason: string;
  }) => void,
): Promise<unknown> {
  const maxSwaps = cfg.maxSwaps ?? DEFAULT_MAX_SWAPS;
  const promptFn = cfg.promptFn ?? defaultPromptWithRetry;
  let activeModel = baseOpts.modelOverride ?? (agent as { model: string }).model;
  let swaps = 0;
  const triedThisCall = new Set<string>();

  if (cfg.enableHealthSwap) {
    const verdict = evaluateModelHealth({
      model: activeModel,
      recentAttempts: state.modelHealth.get(activeModel) ?? [],
    });
    if (verdict.degraded) {
      const swapTarget = pickFailoverTarget(activeModel, triedThisCall, cfg);
      if (swapTarget) {
        onFailover?.({
          fromModel: activeModel,
          toModel: swapTarget,
          classified: classifyError({
            message: `health swap: ${verdict.reason}`,
            causeHint: "model-output",
          }),
          reason: `R10 proactive: ${verdict.reason}`,
        });
        activeModel = swapTarget;
      }
    }
  }

  while (true) {
    triedThisCall.add(activeModel);
    let result: unknown;
    let thrown: unknown = undefined;
    const t0 = Date.now();
    try {
      result = await promptFn(agent as any, promptText, {
        ...baseOpts,
        modelOverride: activeModel,
      } as any);
    } catch (err) {
      thrown = err;
    }
    // Record outcome for R10
    recordAttempt(state.modelHealth, activeModel, {
      success: thrown === undefined,
      ts: t0,
    });
    if (thrown === undefined) return result;

    const classified = classifyError({
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });
    if (swaps >= maxSwaps) throw thrown;

    if (classified.category === "unknown") {
      console.warn(
        `[promptWithFailover] unclassified error on ${activeModel}: ${classified.rawMessage}`,
      );
      if (!triedThisCall.has(`${activeModel}__unknown_retry`)) {
        triedThisCall.add(`${activeModel}__unknown_retry`);
        await interruptibleSleep(UNKNOWN_ERROR_RETRY_BACKOFF_MS, baseOpts.signal);
        continue;
      }
    }

    const decision = decideFailover({
      currentModel: activeModel,
      classified,
      failoverChain: cfg.failoverChain,
      alreadyTried: triedThisCall,
    });

    if (
      decision.action === "retry-same" ||
      classified.category === "cap" ||
      classified.category === "user-stop" ||
      classified.category === "runner-bug" ||
      classified.category === "disk" ||
      classified.category === "oom"
    ) {
      throw thrown;
    }

    let nextModel: string | null = decision.action === "swap" ? (decision.nextModel ?? null) : null;
    if (!nextModel) {
      nextModel = pickLocalFallback({
        failedModel: activeModel,
        localTags: cfg.localTags ?? [],
        preferred: cfg.localPreferred,
      });
      if (nextModel && triedThisCall.has(nextModel)) nextModel = null;
    }
    if (!nextModel) throw thrown;

    onFailover?.({
      fromModel: activeModel,
      toModel: nextModel,
      classified,
      reason: decision.reason,
    });
    activeModel = nextModel;
    swaps += 1;
  }
}

function pickFailoverTarget(
  currentModel: string,
  alreadyTried: ReadonlySet<string>,
  cfg: FailoverConfig,
): string | null {
  for (const m of cfg.failoverChain) {
    if (m !== currentModel && !alreadyTried.has(m)) return m;
  }
  return pickLocalFallback({
    failedModel: currentModel,
    localTags: cfg.localTags ?? [],
    preferred: cfg.localPreferred,
  });
}

function recordAttempt(
  store: Map<string, AttemptRecord[]>,
  model: string,
  record: AttemptRecord,
): void {
  const existing = store.get(model) ?? [];
  existing.push(record);
  store.set(model, trimAttemptWindow(existing));
}
