// W13 + W14 + W15 (2026-05-04): provider-failover wrapper around
// promptWithRetry that consolidates R1 + R3 + R10.
//
// Layered design:
//   - promptWithRetry handles transient retries on the SAME model
//     (network blip, single timeout, malformed-json one-off)
//   - promptWithFailover wraps that loop and handles SWAPS to a
//     different model when promptWithRetry throws
//
// On every promptWithRetry result (success OR throw):
//   1. Push an AttemptRecord into modelHealth (R10)
//   2. On throw: classifyError → decideFailover (R1)
//      - swap action: pick next model via R1's chain or R3's local
//        fallback if cloud-only chain is exhausted; recurse with the
//        new model
//      - retry-same: re-throw (promptWithRetry already exhausted its
//        retries for this model — going around again is pointless)
//      - give-up: re-throw
//   3. Pre-call: if R10 says the active model is degraded, swap
//      proactively even before we try (skips wasting a turn on a
//      known-bad model)
//
// Pure — caller owns the failover state (triedModels, modelHealth).
// State references are passed in + mutated; the helper has no
// module-level singletons.

import type { Agent } from "../services/AgentManager.js";
import {
  promptWithRetry as defaultPromptWithRetry,
  type PromptWithRetryOptions,
} from "./promptWithRetry.js";
import { classifyError, type ClassifiedError } from "./errorTaxonomy.js";
import { decideFailover } from "./providerFailover.js";
import { pickLocalFallback } from "./degradationFallback.js";
import {
  evaluateModelHealth,
  trimAttemptWindow,
  type AttemptRecord,
} from "./modelHealthTracker.js";
import { interruptibleSleep } from "./interruptibleSleep.js";

/** Function shape promptWithFailover invokes for each per-model
 *  attempt. Defaults to promptWithRetry; tests inject a stub. */
export type PromptFn = (
  agent: Agent,
  promptText: string,
  opts: PromptWithRetryOptions,
) => Promise<unknown>;

export interface FailoverState {
  /** Sliding window of attempt records per model. Mutated.
   *  Carries across calls to feed R10's degradation verdict.
   *
   *  2026-05-04 design note: triedModels lives per-call (a fresh Set
   *  is built inside promptWithFailover) so a successful swap on
   *  call N doesn't taint call N+1's options. Cumulative "this model
   *  is bad" state is captured by modelHealth's success rate. */
  modelHealth: Map<string, AttemptRecord[]>;
}

export interface FailoverConfig {
  /** Ordered failover chain of model strings (e.g.
   *  ["claude-haiku-4-5", "glm-5.1:cloud"]). Empty disables R1. */
  failoverChain: readonly string[];
  /** Local Ollama tags available for R3 graceful degradation. Empty
   *  disables R3 (no local fallback when cloud chain exhausted). */
  localTags?: readonly string[];
  /** Preferred local model order for R3. Optional — when omitted,
   *  pickLocalFallback picks the largest local tag. */
  localPreferred?: readonly string[];
  /** Enable R10 proactive health-based swap. When ON: pre-call,
   *  evaluate the active model's recent success rate; if degraded,
   *  swap before even trying. */
  enableHealthSwap?: boolean;
  /** Max number of failover swaps within a single promptWithFailover
   *  call. Bounded so a pathological all-walls-down scenario can't
   *  spin forever. Default 3. */
  maxSwaps?: number;
  /** Test seam: inject a custom prompt function (defaults to
   *  promptWithRetry). Production code never sets this. */
  promptFn?: PromptFn;
}

const DEFAULT_MAX_SWAPS = 3;
const UNKNOWN_ERROR_RETRY_BACKOFF_MS = 5_000;

/** Drop-in for promptWithRetry that adds R1/R3/R10 layered failover.
 *  When failoverChain is empty AND localTags is empty AND health-swap
 *  is OFF, behaves exactly like promptWithRetry. */
export async function promptWithFailover(
  agent: Agent,
  promptText: string,
  baseOpts: PromptWithRetryOptions,
  state: FailoverState,
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
  let activeModel = baseOpts.modelOverride ?? agent.model;
  let swaps = 0;
  // triedModels is PER CALL — see FailoverState comment. Each model
  // we've already attempted in this single promptWithFailover
  // invocation gets pushed in; decideFailover uses it to avoid
  // swap-loops between two failing models.
  const triedThisCall = new Set<string>();
  // Pre-call health swap (R10): if we're configured for it AND the
  // active model is already known-degraded, jump straight to the
  // next failover candidate without burning a turn on it.
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
      result = await promptFn(agent, promptText, {
        ...baseOpts,
        modelOverride: activeModel,
      });
    } catch (err) {
      thrown = err;
    }
    // R10: record outcome.
    recordAttempt(state.modelHealth, activeModel, {
      success: thrown === undefined,
      ts: t0,
    });
    if (thrown === undefined) return result;
    // We threw — classify + decide failover.
    const classified = classifyError({
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });
    if (swaps >= maxSwaps) throw thrown;
    // When classifyError returns "unknown", the error might be an
    // unusual transient (non-standard rate limit, unusual 503 variant,
    // etc.) that isRetryableSdkError didn't catch. Try one more time
    // with a short backoff before swapping models — a retry is cheaper
    // than a model swap and the error might be transient.
    if (classified.category === "unknown") {
      console.warn(
        `[promptWithFailover] unclassified error on ${activeModel}: ${classified.rawMessage}`,
      );
      if (!triedThisCall.has(`${activeModel}__unknown_retry`)) {
        triedThisCall.add(`${activeModel}__unknown_retry`);
        await interruptibleSleep(UNKNOWN_ERROR_RETRY_BACKOFF_MS, baseOpts.signal);
        continue;
      }
      // Second unknown error on the same model — fall through to swap.
    }
    const decision = decideFailover({
      currentModel: activeModel,
      classified,
      failoverChain: cfg.failoverChain,
      alreadyTried: triedThisCall,
    });
    // Don't swap on retry-same (promptWithRetry already exhausted
    // its same-model retries) or on truly terminal categories.
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
    // R1 chain pick first; if R1 returned give-up due to exhaustion
    // (or returned no next model), fall through to R3 local fallback.
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

/** Picks the next failover target for a proactive health swap. Tries
 *  R1's chain first; falls back to R3's local tags. Returns null
 *  when nothing untried is available. */
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

/** Push an attempt record + trim the window. Mutates the map. */
function recordAttempt(
  store: Map<string, AttemptRecord[]>,
  model: string,
  record: AttemptRecord,
): void {
  const existing = store.get(model) ?? [];
  existing.push(record);
  store.set(model, trimAttemptWindow(existing));
}
