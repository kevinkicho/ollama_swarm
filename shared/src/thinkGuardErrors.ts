import type { ThinkGuardVerdict } from "./thinkGuardReferee.js";

export type ThinkGuardTier = 1 | 2;

export interface ThinkGuardTripMetrics {
  thinkChars: number;
  thinkElapsedMs: number;
  repetition: { repeats: number; rLen: number } | null;
}

export interface ThinkGuardTrip {
  tier: ThinkGuardTier;
  reason: string;
  metrics: ThinkGuardTripMetrics;
}

export interface ThinkGuardSession {
  startedAt: number;
  /** Last time a stream chunk was observed (for idle-based MS caps). */
  lastChunkAt: number;
  cumulativeText: string;
  lastTrip?: ThinkGuardTrip;
  softTierTripped: boolean;
  budgetExtended: boolean;
  refereeInvocations: number;
  lastVerdict?: ThinkGuardVerdict;
}

export function createThinkGuardSession(startedAt = Date.now()): ThinkGuardSession {
  return {
    startedAt,
    lastChunkAt: startedAt,
    cumulativeText: "",
    softTierTripped: false,
    budgetExtended: false,
    refereeInvocations: 0,
  };
}

export class ThinkGuardAbortError extends Error {
  readonly name = "ThinkGuardAbortError";
  readonly tier: ThinkGuardTier;
  readonly reason: string;
  readonly partialText: string;
  readonly thinkChars: number;
  readonly thinkElapsedMs: number;
  readonly repetition: { repeats: number; rLen: number } | null;
  readonly activityKind?: string;
  verdict?: ThinkGuardVerdict;

  constructor(opts: {
    tier: ThinkGuardTier;
    reason: string;
    partialText: string;
    thinkChars: number;
    thinkElapsedMs: number;
    repetition?: { repeats: number; rLen: number } | null;
    activityKind?: string;
    verdict?: ThinkGuardVerdict;
  }) {
    super(opts.reason);
    this.tier = opts.tier;
    this.reason = opts.reason;
    this.partialText = opts.partialText;
    this.thinkChars = opts.thinkChars;
    this.thinkElapsedMs = opts.thinkElapsedMs;
    this.repetition = opts.repetition ?? null;
    this.activityKind = opts.activityKind;
    this.verdict = opts.verdict;
  }
}

export function isThinkGuardAbort(err: unknown): err is ThinkGuardAbortError {
  return err instanceof ThinkGuardAbortError;
}

export function isPromptGuardAbort(err: unknown): boolean {
  if (isThinkGuardAbort(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // Idle wall-clock, absolute hard ceiling, think-stream, tool-loop stuck.
  return /wall-clock (idle |absolute )?exceeded|prompt absolute wall-clock|think stream|think-only stream|repetitive reasoning|tool loop stuck|fail-closed hung prompt/i.test(
    msg,
  );
}

export function extractThinkGuardAbortError(
  session: ThinkGuardSession,
  signal: AbortSignal,
): ThinkGuardAbortError | null {
  const reason = signal.reason;
  if (reason instanceof ThinkGuardAbortError) return reason;
  if (session.lastTrip) {
    const { tier, reason: tripReason, metrics } = session.lastTrip;
    return new ThinkGuardAbortError({
      tier,
      reason: tripReason,
      partialText: session.cumulativeText,
      thinkChars: metrics.thinkChars,
      thinkElapsedMs: metrics.thinkElapsedMs,
      repetition: metrics.repetition,
    });
  }
  return null;
}