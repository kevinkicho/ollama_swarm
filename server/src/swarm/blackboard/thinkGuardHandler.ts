/**
 * Stream-abort salvage handler — deterministic "third eye" only.
 * The LLM think-guard referee is retired; triage lives in streamTriagePolicy.
 */

import type { RunConfig } from "../RunConfig.js";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";
import { thinkCharCountInStream } from "@ollama-swarm/shared/streamThinkGuard";
import {
  triageStreamEvidence,
  triageToHandlerAction,
  type StreamTriageResult,
} from "@ollama-swarm/shared/streamTriagePolicy";
import type { ThinkGuardVerdict } from "@ollama-swarm/shared/thinkGuardReferee";

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
  formatExpect?: "json" | "free";
}

/** Planner/replan kinds that benefit from post-abort salvage. */
export function isPlannerTriageKind(kind?: string): boolean {
  return kind === "contract" || kind === "planner-todos" || kind === "replan";
}

/** @deprecated use isPlannerTriageKind */
export const isPlannerRefereeKind = isPlannerTriageKind;

/** Council/discussion draft rounds — salvage partials. */
export function isDiscussionDraftKind(kind?: string): boolean {
  return kind === "discussion" || kind === "council-draft" || kind === "draft";
}

/**
 * Activities that attach a deterministic stream-triage handler.
 * Broader than the old referee gate: any structured emit path, not only explore.
 */
export function isStreamTriageEligible(activity?: PromptActivity): boolean {
  if (!activity?.kind) return false;
  if (isDiscussionDraftKind(activity.kind)) return true;
  if (isPlannerTriageKind(activity.kind)) return true;
  // Workers: salvage long think aborts when they do occur
  if (activity.kind === "worker" || activity.kind === "worker-build") return true;
  return false;
}

/** @deprecated use isStreamTriageEligible — name kept for call-site compatibility */
export function isThinkGuardRefereeEligible(activity?: PromptActivity): boolean {
  return isStreamTriageEligible(activity);
}

/** Recovery-loop checkpoints — planner kinds only; no budget / flag. */
export function resolveRecoveryTriageOn(
  kind: string | undefined,
  _cfg: RunConfig | undefined,
  opts: { stopping?: boolean; draining?: boolean } = {},
): boolean {
  if (!isPlannerTriageKind(kind)) return false;
  if (opts.stopping || opts.draining) return false;
  return true;
}

/** @deprecated use resolveRecoveryTriageOn */
export const resolveRecoveryRefereeOn = resolveRecoveryTriageOn;

/**
 * Whether soft-tier (pre-hard) stream abort is active.
 * Always false — soft tier existed only to feed the retired LLM referee.
 * Hard think-stream caps remain via checkHard.
 */
export function resolveStreamTriageOn(
  activity: PromptActivity | undefined,
  _cfg: RunConfig | undefined,
  opts: { stopping?: boolean; draining?: boolean } = {},
): boolean {
  // Soft-tier OFF always. Handler still attaches for hard-abort salvage.
  void activity;
  void opts;
  return false;
}

/** @deprecated soft-tier always off; use resolveStreamTriageOn */
export function resolveThinkGuardRefereeOn(
  activity: PromptActivity | undefined,
  cfg: RunConfig | undefined,
  opts: { stopping?: boolean; draining?: boolean } = {},
): boolean {
  return resolveStreamTriageOn(activity, cfg, opts);
}

export interface ThinkGuardHandlerState {
  continuationUsed?: boolean;
  /** @deprecated no LLM referee invocations */
  refereeInvocations?: number;
  triageInvocations?: number;
}

export type RecoveryTriageResult = {
  salvageBrief?: string;
  forceEmit: boolean;
  rationale: string;
  verdict: ThinkGuardVerdict;
};

/** @deprecated alias */
export type RecoveryRefereeResult = RecoveryTriageResult;

function logTriage(
  deps: Pick<ThinkGuardHandlerDeps, "appendSystem" | "logDiag" | "runId" | "activity">,
  err: ThinkGuardAbortError,
  triage: StreamTriageResult,
): void {
  deps.appendSystem(
    `[stream-triage] tier ${err.tier} @ ${err.thinkChars.toLocaleString()} chars — ` +
      `${triage.action} (${triage.verdict.verdict}/${triage.verdict.confidence}): ${triage.verdict.rationale}`,
  );
  deps.logDiag?.({
    type: "stream_triage",
    runId: deps.runId,
    tier: err.tier,
    thinkChars: err.thinkChars,
    thinkElapsedMs: err.thinkElapsedMs,
    action: triage.action,
    reason: triage.reason,
    verdict: triage.verdict.verdict,
    confidence: triage.verdict.confidence,
    activityKind: deps.activity?.kind,
    activityLabel: deps.activity?.label,
  });
}

/**
 * Discussion/council draft salvage: prefer partial stream over silent fail.
 */
export function createDiscussionThinkGuardHandler(
  deps: Pick<ThinkGuardHandlerDeps, "appendSystem" | "logDiag" | "runId" | "activity">,
): ThinkGuardHandler {
  let continuationUsed = false;
  return {
    async handleAbort(err: ThinkGuardAbortError): Promise<ThinkGuardHandlerResult> {
      const triage = triageStreamEvidence({
        partialText: err.partialText,
        thinkChars: err.thinkChars,
        thinkElapsedMs: err.thinkElapsedMs,
        tier: err.tier as 1 | 2,
        repetition: err.repetition,
        abortReason: err.reason,
      });
      logTriage(deps, err, triage);

      const dispatched = triageToHandlerAction(
        triage,
        err.partialText || "",
        continuationUsed,
      );
      if (dispatched.type === "continuation_prompt") {
        continuationUsed = true;
        return {
          type: "continuation_prompt",
          prompt: dispatched.prompt!,
          verdict: dispatched.verdict,
        };
      }
      if (dispatched.type === "return_partial") {
        deps.appendSystem(
          `[stream-triage] discussion salvage — partial (${(err.partialText ?? "").length} chars)`,
        );
        return {
          type: "return_partial",
          text: dispatched.text ?? err.partialText ?? "",
          verdict: dispatched.verdict,
        };
      }
      return { type: "rethrow" };
    },
  };
}

/**
 * Deterministic post-abort handler for planner / worker / discussion.
 * Always returns a handler when eligible (no referee budget / flag).
 */
export function createThinkGuardHandler(
  deps: ThinkGuardHandlerDeps,
  state: ThinkGuardHandlerState = {},
): ThinkGuardHandler | undefined {
  if (deps.isStopping() || deps.isDraining()) return undefined;

  if (isDiscussionDraftKind(deps.activity?.kind)) {
    return createDiscussionThinkGuardHandler(deps);
  }

  if (!isStreamTriageEligible(deps.activity)) {
    return undefined;
  }

  return {
    async handleAbort(err: ThinkGuardAbortError): Promise<ThinkGuardHandlerResult> {
      state.triageInvocations = (state.triageInvocations ?? 0) + 1;

      const triage = triageStreamEvidence({
        partialText: err.partialText,
        thinkChars: err.thinkChars,
        thinkElapsedMs: err.thinkElapsedMs,
        tier: err.tier as 1 | 2,
        repetition: err.repetition,
        abortReason: err.reason,
        formatExpect: deps.formatExpect,
      });
      err.verdict = triage.verdict;
      logTriage(deps, err, triage);

      const dispatched = triageToHandlerAction(
        triage,
        err.partialText || "",
        state.continuationUsed === true,
      );
      if (dispatched.type === "continuation_prompt") {
        state.continuationUsed = true;
        return {
          type: "continuation_prompt",
          prompt: dispatched.prompt!,
          verdict: dispatched.verdict,
        };
      }
      if (dispatched.type === "return_partial") {
        return {
          type: "return_partial",
          text: dispatched.text ?? err.partialText ?? "",
          verdict: dispatched.verdict,
        };
      }
      return { type: "rethrow" };
    },
  };
}

/**
 * Proactive triage when planner/replan recovery loops stall (no LLM).
 */
export async function runRecoveryStreamTriage(
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
): Promise<RecoveryTriageResult | null> {
  const cfg = deps.getActive();
  if (!resolveRecoveryTriageOn(deps.kind, cfg, {
    stopping: deps.isStopping(),
    draining: deps.isDraining?.() ?? false,
  })) {
    return null;
  }

  const thinkChars = thinkCharCountInStream(input.partialText);
  const err = new ThinkGuardAbortError({
    tier: 2,
    reason: `recovery loop attempt ${input.attempt}: ${input.lastReason}`,
    partialText: input.partialText,
    thinkChars: Math.max(thinkChars, input.partialText.length),
    thinkElapsedMs: 0,
    activityKind: deps.kind,
  });

  deps.appendSystem(
    `[stream-triage] recovery checkpoint (attempt ${input.attempt}) — deterministic salvage…`,
  );

  const triage = triageStreamEvidence({
    partialText: input.partialText,
    thinkChars: err.thinkChars,
    recoveryAttempt: input.attempt,
    lastFailReason: input.lastReason,
    formatExpect: "json",
  });
  err.verdict = triage.verdict;

  deps.logDiag?.({
    type: "stream_triage_recovery",
    runId: cfg?.runId,
    attempt: input.attempt,
    action: triage.action,
    reason: triage.reason,
    kind: deps.kind,
  });

  const brief = triage.salvageBrief?.trim();
  const forceEmit =
    triage.action === "force_emit"
    || triage.action === "class_repair"
    || triage.verdict.verdict === "ready_to_emit"
    || !!brief;

  if (triage.action === "fail" && !brief && !forceEmit) {
    return null;
  }

  return {
    salvageBrief: brief || (forceEmit ? input.partialText.slice(0, 4000) : undefined),
    forceEmit,
    rationale: triage.verdict.rationale,
    verdict: triage.verdict,
  };
}

/** @deprecated use runRecoveryStreamTriage */
export const runRecoveryRefereeCheckpoint = runRecoveryStreamTriage;
