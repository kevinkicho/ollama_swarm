import type { Agent } from "../../services/AgentManager.js";
import type { RunConfig } from "../RunConfig.js";
import { config } from "../../config.js";
import { chatOnce } from "../chatOnce.js";
import {
  resolveThinkGuardRefereeBudget,
  THINK_GUARD_REFEREE_LIMITS,
} from "@ollama-swarm/shared/thinkGuardBudget";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";
import { thinkCharCountInStream } from "@ollama-swarm/shared/streamThinkGuard";
import {
  buildThinkGuardRefereePrompt,
  clipThinkTail,
  parseThinkGuardVerdict,
  THINK_GUARD_VERDICT_SCHEMA,
  type ThinkGuardVerdict,
} from "@ollama-swarm/shared/thinkGuardReferee";

export type PromptActivity = {
  kind?: string;
  label?: string;
  mode?: "explore" | "emit";
};

export interface ThinkGuardHandler {
  handleAbort(err: ThinkGuardAbortError): Promise<ThinkGuardHandlerResult>;
}

export type ThinkGuardHandlerResult =
  | { type: "return_partial"; text: string; verdict: ThinkGuardVerdict }
  | { type: "continuation_prompt"; prompt: string; verdict: ThinkGuardVerdict }
  | { type: "rethrow" };

export interface ThinkGuardHandlerDeps {
  getActive: () => RunConfig | undefined;
  isStopping: () => boolean;
  isDraining: () => boolean;
  appendSystem: (msg: string) => void;
  logDiag?: (record: unknown) => void;
  runId?: string;
  activity?: PromptActivity;
  promptExcerpt?: string;
  signal?: AbortSignal;
  clonePath?: string;
}

export function isPlannerRefereeKind(kind?: string): boolean {
  return kind === "contract" || kind === "planner-todos" || kind === "replan";
}

/** Council/discussion draft rounds — salvage partials without requiring referee budget. */
export function isDiscussionDraftKind(kind?: string): boolean {
  return kind === "discussion" || kind === "council-draft" || kind === "draft";
}

export function isThinkGuardRefereeEligible(activity?: PromptActivity): boolean {
  return activity?.mode === "explore" && isPlannerRefereeKind(activity.kind);
}

/** Recovery-loop checkpoints — kind-based; emit-mode retries still qualify. */
export function resolveRecoveryRefereeOn(
  kind: string | undefined,
  cfg: RunConfig | undefined,
  opts: { stopping?: boolean; draining?: boolean } = {},
): boolean {
  if (!isPlannerRefereeKind(kind)) return false;
  if (opts.stopping || opts.draining) return false;
  const enabled = cfg?.thinkGuardRefereeEnabled ?? config.THINK_GUARD_REFEREE_ENABLED;
  if (!enabled) return false;
  const budget = resolveThinkGuardRefereeBudget(cfg, config.THINK_GUARD_REFEREE_ENABLED);
  return budget.callsRemaining > 0;
}

export function resolveThinkGuardRefereeOn(
  activity: PromptActivity | undefined,
  cfg: RunConfig | undefined,
  opts: { stopping?: boolean; draining?: boolean } = {},
): boolean {
  if (!isThinkGuardRefereeEligible(activity)) return false;
  if (opts.stopping || opts.draining) return false;
  const enabled = cfg?.thinkGuardRefereeEnabled ?? config.THINK_GUARD_REFEREE_ENABLED;
  if (!enabled) return false;
  const budget = resolveThinkGuardRefereeBudget(cfg, config.THINK_GUARD_REFEREE_ENABLED);
  return budget.callsRemaining > 0;
}

function refereeModel(cfg: RunConfig | undefined): string {
  return (
    cfg?.thinkGuardRefereeModel
    ?? cfg?.workerModel
    ?? cfg?.model
    ?? config.DEFAULT_MODEL
  );
}

function ephemeralRefereeAgent(model: string, clonePath?: string): Agent {
  return {
    id: "think-guard-referee",
    index: 0,
    port: 0,
    sessionId: "think-guard-referee",
    model,
    cwd: clonePath ?? "",
  } as Agent;
}

function ruleBasedFallback(err: ThinkGuardAbortError): ThinkGuardVerdict {
  if (err.repetition && err.repetition.repeats >= 5) {
    return {
      verdict: "loop",
      confidence: "high",
      rationale: "Hard repetitive tail detected",
      suggestedAction: "abort",
    };
  }
  if (err.thinkChars > 100_000) {
    return {
      verdict: "ready_to_emit",
      confidence: "medium",
      rationale: "Long think stream — salvage via emit",
      suggestedAction: "force_emit",
    };
  }
  return {
    verdict: "slow_progress",
    confidence: "low",
    rationale: "Referee unavailable — one continuation",
    suggestedAction: "extend_budget",
  };
}

function buildContinuationPrompt(err: ThinkGuardAbortError, verdict: ThinkGuardVerdict): string {
  const tail = clipThinkTail(err.partialText, 8_000);
  const brief = verdict.salvageableBrief?.trim();
  return [
    "Your prior think-only stream was interrupted after long reasoning.",
    `Triage: ${verdict.verdict} (${verdict.confidence}) — ${verdict.rationale}`,
    brief ? `Salvageable brief:\n${brief}` : "",
    "Continue from your reasoning and produce the required structured JSON output now.",
    "Do not restart a full repo exploration from scratch.",
    tail ? `Recent reasoning tail:\n${tail}` : "",
  ].filter(Boolean).join("\n\n");
}

function dispatchVerdict(
  err: ThinkGuardAbortError,
  verdict: ThinkGuardVerdict,
  budgetExtended: boolean,
): ThinkGuardHandlerResult {
  const action = verdict.suggestedAction;
  if (verdict.verdict === "loop" && verdict.confidence === "high" && action !== "force_emit") {
    return { type: "rethrow" };
  }
  if (action === "abort" && verdict.confidence === "high") {
    return { type: "rethrow" };
  }
  if (
    verdict.verdict === "ready_to_emit"
    || action === "force_emit"
    || action === "nudge_emit"
    || (verdict.verdict === "loop" && verdict.salvageableBrief)
  ) {
    return { type: "return_partial", text: err.partialText, verdict };
  }
  if (
    (verdict.verdict === "slow_progress" || action === "extend_budget")
    && !budgetExtended
  ) {
    return {
      type: "continuation_prompt",
      prompt: buildContinuationPrompt(err, verdict),
      verdict,
    };
  }
  if (verdict.verdict === "needs_tools") {
    return { type: "return_partial", text: err.partialText, verdict };
  }
  return { type: "return_partial", text: err.partialText, verdict };
}

async function invokeReferee(
  deps: ThinkGuardHandlerDeps,
  err: ThinkGuardAbortError,
  cfg: RunConfig | undefined,
): Promise<ThinkGuardVerdict | null> {
  const budget = resolveThinkGuardRefereeBudget(cfg, config.THINK_GUARD_REFEREE_ENABLED);
  const model = refereeModel(cfg);
  const prompt = buildThinkGuardRefereePrompt({
    taskLabel: deps.activity?.label ?? deps.activity?.kind ?? "explore",
    activityKind: deps.activity?.kind,
    thinkChars: err.thinkChars,
    thinkElapsedMs: err.thinkElapsedMs,
    repetitionHint: err.repetition
      ? `${err.repetition.repeats}×${err.repetition.rLen} tail`
      : undefined,
    partialText: err.partialText,
    originalPromptExcerpt: deps.promptExcerpt,
    thinkTailMaxChars: budget.thinkTailMaxChars,
    thinkTailMinChars: budget.thinkTailMinChars,
  });

  const maxTok = cfg?.thinkGuardRefereeMaxOutputTokens
    ?? THINK_GUARD_REFEREE_LIMITS.maxOutputTokens.default;

  try {
    const res = await chatOnce(ephemeralRefereeAgent(model, deps.clonePath ?? cfg?.localPath), {
      agentName: "swarm",
      promptText: prompt,
      signal: deps.signal,
      runId: deps.runId,
      clonePath: deps.clonePath ?? cfg?.localPath,
      format: THINK_GUARD_VERDICT_SCHEMA,
      promptWallClockMs: 45_000,
      maxToolTurns: 0,
      refereeOn: false,
    });
    const raw = res.data.parts[0]?.text ?? "";
    return parseThinkGuardVerdict(raw);
  } catch (e) {
    deps.logDiag?.({
      type: "think_guard_referee_error",
      runId: deps.runId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export interface ThinkGuardHandlerState {
  continuationUsed?: boolean;
  refereeInvocations?: number;
}

export type RecoveryRefereeResult = {
  salvageBrief?: string;
  forceEmit: boolean;
  rationale: string;
  verdict: ThinkGuardVerdict;
};

/**
 * Proactive referee when planner/replan recovery loops retry without tripping
 * the in-stream think guard (tool-heavy explore, emit parse failures, etc.).
 */
export async function runRecoveryRefereeCheckpoint(
  deps: {
    getActive: () => RunConfig | undefined;
    isStopping: () => boolean;
    isDraining?: () => boolean;
    appendSystem: (msg: string) => void;
    logDiag?: (record: unknown) => void;
    clonePath?: string;
    kind: string;
    label?: string;
    promptExcerpt?: string;
    signal?: AbortSignal;
  },
  input: {
    partialText: string;
    attempt: number;
    lastReason: string;
  },
): Promise<RecoveryRefereeResult | null> {
  const cfg = deps.getActive();
  if (!resolveRecoveryRefereeOn(deps.kind, cfg, {
    stopping: deps.isStopping(),
    draining: deps.isDraining?.() ?? false,
  })) {
    return null;
  }

  const activity: PromptActivity = {
    kind: deps.kind,
    label: deps.label ?? deps.kind,
    mode: "explore",
  };
  const handler = createThinkGuardHandler(
    {
      getActive: deps.getActive,
      isStopping: deps.isStopping,
      isDraining: deps.isDraining ?? (() => false),
      appendSystem: deps.appendSystem,
      logDiag: deps.logDiag,
      runId: cfg?.runId,
      activity,
      promptExcerpt: deps.promptExcerpt,
      signal: deps.signal,
      clonePath: deps.clonePath ?? cfg?.localPath,
    },
    {},
  );
  if (!handler) return null;

  const thinkChars = thinkCharCountInStream(input.partialText);
  const err = new ThinkGuardAbortError({
    tier: 1,
    reason: `recovery loop attempt ${input.attempt}: ${input.lastReason}`,
    partialText: input.partialText,
    thinkChars: Math.max(thinkChars, input.partialText.length),
    thinkElapsedMs: 0,
    activityKind: deps.kind,
  });

  deps.appendSystem(
    `[think-guard] recovery checkpoint (attempt ${input.attempt}) — referee reviewing planner stall…`,
  );

  const result = await handler.handleAbort(err);
  const verdict = err.verdict ?? ruleBasedFallback(err);
  const brief = verdict.salvageableBrief?.trim();
  const forceEmit =
    verdict.verdict === "ready_to_emit"
    || verdict.suggestedAction === "force_emit"
    || verdict.suggestedAction === "nudge_emit"
    || !!brief;

  if (result.type === "rethrow" && !brief && !forceEmit) {
    return null;
  }

  return {
    salvageBrief: brief || (forceEmit ? input.partialText : undefined),
    forceEmit,
    rationale: verdict.rationale,
    verdict,
  };
}

/**
 * Discussion/council draft salvage: prefer partial stream over silent fail.
 * Does not consume referee budget. Hard pure-loop with no salvageable text rethrows.
 */
export function createDiscussionThinkGuardHandler(
  deps: Pick<ThinkGuardHandlerDeps, "appendSystem" | "logDiag" | "runId" | "activity">,
): ThinkGuardHandler {
  let continuationUsed = false;
  return {
    async handleAbort(err: ThinkGuardAbortError): Promise<ThinkGuardHandlerResult> {
      const partial = err.partialText?.trim() ?? "";
      const hardLoop = !!(err.repetition && err.repetition.repeats >= 5 && err.tier === 2);

      deps.logDiag?.({
        type: "think_guard_discussion_salvage",
        runId: deps.runId,
        tier: err.tier,
        thinkChars: err.thinkChars,
        hardLoop,
        partialLen: partial.length,
        activityKind: deps.activity?.kind,
        activityLabel: deps.activity?.label,
      });

      if (hardLoop && partial.length < 80) {
        deps.appendSystem(
          `[think-guard] discussion hard loop with no salvageable text — ${err.reason}`,
        );
        return { type: "rethrow" };
      }

      // Soft tier / mixed stream: one continuation, then force partial.
      if (
        err.tier === 1
        && !continuationUsed
        && partial.length > 0
        && !(err.repetition && err.repetition.repeats >= 5)
      ) {
        continuationUsed = true;
        const verdict = ruleBasedFallback(err);
        deps.appendSystem(
          `[think-guard] discussion soft abort — one emit continuation (${err.thinkChars.toLocaleString()} chars)`,
        );
        return {
          type: "continuation_prompt",
          prompt: buildContinuationPrompt(err, {
            ...verdict,
            suggestedAction: "nudge_emit",
            rationale: "Discussion draft soft-cap — finish your draft JSON/findings now.",
          }),
          verdict: { ...verdict, suggestedAction: "nudge_emit" },
        };
      }

      deps.appendSystem(
        `[think-guard] discussion salvage — returning partial stream (${partial.length} chars; ${err.reason})`,
      );
      return {
        type: "return_partial",
        text: err.partialText || "",
        verdict: {
          verdict: "ready_to_emit",
          confidence: "medium",
          rationale: "Discussion draft: salvage partial rather than silent fail",
          suggestedAction: "force_emit",
        },
      };
    },
  };
}

export function createThinkGuardHandler(
  deps: ThinkGuardHandlerDeps,
  state: ThinkGuardHandlerState = {},
): ThinkGuardHandler | undefined {
  // Discussion drafts: always attach lightweight salvage (no referee gate).
  if (isDiscussionDraftKind(deps.activity?.kind)) {
    return createDiscussionThinkGuardHandler(deps);
  }

  const cfg = deps.getActive();
  if (!resolveThinkGuardRefereeOn(deps.activity, cfg, {
    stopping: deps.isStopping(),
    draining: deps.isDraining(),
  })) {
    return undefined;
  }

  return {
    async handleAbort(err: ThinkGuardAbortError): Promise<ThinkGuardHandlerResult> {
      const active = deps.getActive();
      const budget = resolveThinkGuardRefereeBudget(active, config.THINK_GUARD_REFEREE_ENABLED);
      if (budget.callsRemaining <= 0) {
        return { type: "rethrow" };
      }

      deps.appendSystem(
        `[think-guard] tier ${err.tier} at ${err.thinkChars.toLocaleString()} chars — referee reviewing…`,
      );
      deps.logDiag?.({
        type: "think_guard_checkpoint",
        runId: deps.runId,
        tier: err.tier,
        thinkChars: err.thinkChars,
        thinkElapsedMs: err.thinkElapsedMs,
        activityKind: deps.activity?.kind,
        activityLabel: deps.activity?.label,
      });

      if (active) {
        active.thinkGuardRefereeCallsUsed = (active.thinkGuardRefereeCallsUsed ?? 0) + 1;
      }
      state.refereeInvocations = (state.refereeInvocations ?? 0) + 1;

      const verdict = (await invokeReferee(deps, err, active)) ?? ruleBasedFallback(err);
      err.verdict = verdict;

      deps.appendSystem(
        `[think-guard] referee ${verdict.verdict} (${verdict.confidence}): ${verdict.rationale}`,
      );
      deps.logDiag?.({
        type: "think_guard_verdict",
        runId: deps.runId,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        suggestedAction: verdict.suggestedAction,
      });

      const dispatched = dispatchVerdict(err, verdict, state.continuationUsed === true);
      if (dispatched.type === "continuation_prompt") state.continuationUsed = true;
      return dispatched;
    },
  };
}