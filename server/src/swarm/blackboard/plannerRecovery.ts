// Planner-owned structured emit recovery.
// Cascade: rule-based extract → explore/emit turns → auditor JSON salvage → sibling-retry.

import type { Agent } from "../../services/AgentManager.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import {
  extractJsonCandidate,
  formatParseTier,
} from "@ollama-swarm/shared/parseAgentJson";
import { interruptibleSleep } from "../interruptibleSleep.js";
import { runPlannerAuditorSalvage } from "./plannerAuditorAssist.js";
import { isRetryableSdkError } from "./retry.js";
import { describeSdkError } from "../sdkError.js";
import { isThinkGuardAbort } from "@ollama-swarm/shared/thinkGuardErrors";
import { runRecoveryStreamTriage } from "./thinkGuardHandler.js";
import type { RunConfig } from "../RunConfig.js";
import { repairAndParseJson } from "../repairJson.js";

export const PLANNER_EMIT_MAX_ATTEMPTS = 4;
export const PLANNER_EMIT_PAUSE_BASE_MS = 12_000;

export type ParseAttemptResult<T> =
  | { ok: true; value: T; raw: string; dropped?: unknown[] }
  | { ok: false; reason: string; raw: string };

export interface PlannerEmitRecoveryOpts<T> {
  kind: "contract" | "planner-todos";
  agent: Agent;
  auditor?: Agent;
  getStopping: () => boolean;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { assistKind?: "auditor-salvage" },
  ) => void;
  findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
  emitActivity: (label: string, attempt: number, maxAttempts: number, mode: "explore" | "emit") => void;
  promptPlannerSafely: (
    agent: Agent,
    promptText: string,
    agentName: ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: { kind?: string; label?: string; mode?: "explore" | "emit" },
  ) => Promise<{ response: string; agentUsed: Agent }>;
  buildExplorePrompt: () => string;
  buildRepairPrompt: (previousResponse: string, parseError: string, auditorNote?: string) => string;
  exploreProfile: ProfileName;
  emitProfile: ProfileName;
  jsonSchema: Record<string, unknown>;
  parse: (raw: string) => ParseAttemptResult<T>;
  getActive: () => (RunConfig & { dedicatedAuditor?: boolean }) | undefined;
  maxAttempts?: number;
  clonePath?: string;
  logDiag?: (record: unknown) => void;
  promptExcerpt?: string;
  /** When set, first loop iteration is emit-only using this prior explore prose. */
  cachedExploreResponse?: string;
  /**
   * D12: seed is rich enough — attempt 1 is structured emit using buildExplorePrompt
   * (full seed) with no prior explore turn.
   */
  emitDirectFromSeed?: boolean;
  /** Fired after each non-emit explore turn completes (for cross-phase cache). */
  onExploreCaptured?: (response: string) => void;
}

function responseExcerpt(raw: string, max = 8000): string {
  const t = raw.trim();
  return t.length <= max ? t : t.slice(0, max - 3) + "...";
}

function tryParseWithRuleBasedExtract<T>(
  raw: string,
  parse: (r: string) => ParseAttemptResult<T>,
  appendSystem: (msg: string) => void,
  agentId: string,
  kind: string,
): ParseAttemptResult<T> {
  const direct = parse(raw);
  if (direct.ok) return direct;

  const candidate = extractJsonCandidate(raw);
  if (candidate) {
    const salvaged = parse(candidate.json);
    if (salvaged.ok) {
      appendSystem(
        `[${agentId}] ${kind} rule-based JSON extract (${formatParseTier(candidate.tier)}) succeeded.`,
      );
      return salvaged;
    }
  }

  // Soft repair (fences / bare keys) before burning another LLM emit turn.
  const soft = repairAndParseJson(raw);
  if (soft?.value !== undefined) {
    const asJson = JSON.stringify(soft.value);
    const salvaged = parse(asJson);
    if (salvaged.ok) {
      appendSystem(
        `[${agentId}] ${kind} soft-repair JSON (${soft.strategy}) succeeded — skipping extra emit.`,
      );
      return salvaged;
    }
  }
  return direct;
}

/** Pause between planner emit attempts (no wall-clock cap on a single turn). */
export async function pauseBetweenPlannerAttempts(
  attempt: number,
  getStopping: () => boolean,
): Promise<void> {
  if (attempt <= 1 || getStopping()) return;
  const ms = PLANNER_EMIT_PAUSE_BASE_MS * Math.min(attempt - 1, 5);
  const controller = new AbortController();
  await interruptibleSleep(ms, controller.signal);
}

async function applyRecoveryRefereeSalvage<T>(
  opts: PlannerEmitRecoveryOpts<T>,
  input: {
    attempt: number;
    lastReason: string;
    partialText: string;
    exploreResponse: string;
  },
): Promise<{ exploreResponse: string; lastReason: string; applied: boolean }> {
  const salvage = await runRecoveryStreamTriage(
    {
      getActive: opts.getActive as () => RunConfig | undefined,
      isStopping: opts.getStopping,
      appendSystem: opts.appendSystem,
      logDiag: opts.logDiag,
      clonePath: opts.clonePath ?? opts.getActive()?.localPath,
      kind: opts.kind,
      label: opts.kind,
      promptExcerpt: opts.promptExcerpt,
    },
    {
      partialText: input.partialText,
      attempt: input.attempt,
      lastReason: input.lastReason,
    },
  );
  if (!salvage) {
    return { exploreResponse: input.exploreResponse, lastReason: input.lastReason, applied: false };
  }
  const brief = salvage.salvageBrief?.trim() || input.partialText;
  opts.appendSystem(
    `[${opts.agent.id}] ${opts.kind} recovery referee: ${salvage.verdict.verdict} (${salvage.verdict.confidence}) — ${salvage.rationale}`,
  );
  return {
    exploreResponse: brief,
    lastReason: `recovery-referee: ${salvage.rationale}`,
    applied: true,
  };
}

function thinkGuardSalvageContinue(err: import("@ollama-swarm/shared/thinkGuardErrors").ThinkGuardAbortError): boolean {
  const brief = err.verdict?.salvageableBrief?.trim();
  return !!(
    brief
    || err.verdict?.suggestedAction === "force_emit"
    || err.verdict?.suggestedAction === "nudge_emit"
    || err.verdict?.verdict === "ready_to_emit"
  );
}

export async function runPlannerEmitRecovery<T>(
  opts: PlannerEmitRecoveryOpts<T>,
): Promise<
  | { ok: true; value: T; raw: string; dropped: unknown[] }
  | { ok: false; reason: string; lastRaw: string }
> {
  const maxAttempts = opts.maxAttempts ?? PLANNER_EMIT_MAX_ATTEMPTS;
  let lastRaw = "";
  let lastReason = "no attempts";
  let exploreResponse = opts.cachedExploreResponse?.trim() ?? "";
  const emitDirectFromSeed = opts.emitDirectFromSeed === true;
  const skipInitialExplore = exploreResponse.length > 0 || emitDirectFromSeed;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.getStopping()) {
      return { ok: false, reason: "run stopping", lastRaw };
    }

    await pauseBetweenPlannerAttempts(attempt, opts.getStopping);

    if (
      attempt >= 3
      && lastReason !== "no attempts"
      && (lastRaw.length > 0 || exploreResponse.length > 0)
    ) {
      const salvage = await applyRecoveryRefereeSalvage(opts, {
        attempt,
        lastReason,
        partialText: lastRaw || exploreResponse,
        exploreResponse,
      });
      if (salvage.applied) {
        exploreResponse = salvage.exploreResponse;
        lastReason = salvage.lastReason;
      }
    }

    if (attempt >= 3 && attempt % 2 === 1 && opts.auditor) {
      const salvagedJson = await runPlannerAuditorSalvage(
        opts.auditor,
        {
          getStopping: opts.getStopping,
          appendSystem: opts.appendSystem,
          appendAgent: opts.appendAgent,
          findingsPost: opts.findingsPost,
          promptPlannerSafely: (a, p, n, schema) => opts.promptPlannerSafely(a, p, n!, schema),
          getActive: opts.getActive,
        },
        {
          kind: opts.kind,
          parseError: lastReason,
          responseExcerpt: lastRaw || exploreResponse,
          attempt,
          jsonSchema: opts.jsonSchema,
        },
      );
      if (salvagedJson) {
        const salvaged = opts.parse(salvagedJson);
        if (salvaged.ok) {
          opts.appendSystem(
            `[${opts.agent.id}] ${opts.kind} auditor salvage parsed successfully on attempt ${attempt}/${maxAttempts}.`,
          );
          return {
            ok: true,
            value: salvaged.value,
            raw: salvagedJson,
            dropped: (salvaged.dropped as unknown[]) ?? [],
          };
        }
        lastReason = salvaged.reason;
        lastRaw = salvagedJson;
      }
    }

    const useEmitOnly = emitDirectFromSeed
      ? true
      : skipInitialExplore
        ? attempt % 2 === 1
        : attempt >= 2 && attempt % 2 === 0;
    const mode: "explore" | "emit" = useEmitOnly ? "emit" : "explore";
    const profile = useEmitOnly ? opts.emitProfile : opts.exploreProfile;
    const label = useEmitOnly
      ? emitDirectFromSeed && attempt === 1
        ? `${opts.kind} seed-direct emit`
        : `${opts.kind} emit-only retry`
      : `${opts.kind} derivation`;

    opts.emitActivity(label, attempt, maxAttempts, mode);
    opts.appendSystem(
      `[${opts.agent.id}] ${label} — attempt ${attempt}/${maxAttempts}${useEmitOnly ? " (structured emit)" : ""}`,
    );

    const prompt = useEmitOnly
      ? emitDirectFromSeed && attempt === 1
        ? opts.buildExplorePrompt()
        : opts.buildRepairPrompt(lastRaw || exploreResponse, lastReason)
      : attempt === 1 && !skipInitialExplore
        ? opts.buildExplorePrompt()
        : opts.buildRepairPrompt(lastRaw || exploreResponse, lastReason);

    let response: string;
    let agentUsed: Agent;
    try {
      const prompted = await opts.promptPlannerSafely(
        opts.agent,
        prompt,
        profile,
        useEmitOnly ? opts.jsonSchema : undefined,
        { kind: opts.kind, label, mode },
      );
      response = prompted.response;
      agentUsed = prompted.agentUsed;
    } catch (err) {
      if (opts.getStopping()) return { ok: false, reason: "run stopping", lastRaw: lastRaw || "" };
      if (isThinkGuardAbort(err)) {
        lastRaw = err.partialText;
        if (thinkGuardSalvageContinue(err)) {
          lastReason = `think-guard-salvage: ${err.reason}`;
          exploreResponse = err.verdict?.salvageableBrief?.trim() || err.partialText;
          continue;
        }
        const salvage = await applyRecoveryRefereeSalvage(opts, {
          attempt,
          lastReason: err.reason,
          partialText: err.partialText,
          exploreResponse,
        });
        if (salvage.applied) {
          exploreResponse = salvage.exploreResponse;
          lastReason = salvage.lastReason;
          continue;
        }
        lastReason = `think-guard: ${err.reason}`;
        return { ok: false, reason: lastReason, lastRaw };
      }
      const msg = describeSdkError(err);
      lastReason = `transport: ${msg}`;
      opts.appendSystem(
        `[${opts.agent.id}] ${opts.kind} transport error (attempt ${attempt}/${maxAttempts}): ${msg}`,
      );
      if (!isRetryableSdkError(err)) {
        return { ok: false, reason: lastReason, lastRaw: lastRaw || "" };
      }
      continue;
    }
    if (opts.getStopping()) return { ok: false, reason: "run stopping", lastRaw: response };

    opts.appendAgent(agentUsed, response);
    lastRaw = response;

    const parsed = tryParseWithRuleBasedExtract(
      response,
      opts.parse,
      opts.appendSystem,
      opts.agent.id,
      opts.kind,
    );
    if (parsed.ok) {
      opts.appendSystem(
        `[${opts.agent.id}] ${opts.kind} parsed successfully on attempt ${attempt}/${maxAttempts}` +
          (useEmitOnly ? "." : " (from explore turn)."),
      );
      return {
        ok: true,
        value: parsed.value,
        raw: response,
        dropped: (parsed.dropped as unknown[]) ?? [],
      };
    }

    lastReason = parsed.reason;
    if (!useEmitOnly) {
      exploreResponse = response;
      opts.onExploreCaptured?.(response);
      opts.appendSystem(
        `[${opts.agent.id}] ${opts.kind} explore complete (attempt ${attempt}/${maxAttempts}) — structured emit pending.`,
      );
      continue;
    }
    opts.appendSystem(
      `[${opts.agent.id}] ${opts.kind} parse failed (attempt ${attempt}/${maxAttempts}): ${parsed.reason}`,
    );
    const postEmitSalvage = await applyRecoveryRefereeSalvage(opts, {
      attempt,
      lastReason: parsed.reason,
      partialText: response,
      exploreResponse,
    });
    if (postEmitSalvage.applied) {
      exploreResponse = postEmitSalvage.exploreResponse;
      lastReason = postEmitSalvage.lastReason;
    }
  }

  opts.appendSystem(
    `[${opts.agent.id}] ${opts.kind} emit exhausted ${maxAttempts} attempts — last error: ${lastReason}`,
  );
  opts.findingsPost({
    agentId: opts.agent.id,
    text: `Planner ${opts.kind} failed after ${maxAttempts} attempts. Last error: ${lastReason}. Response excerpt: ${responseExcerpt(lastRaw, 1500)}`,
    createdAt: Date.now(),
  });

  return { ok: false, reason: lastReason, lastRaw };
}