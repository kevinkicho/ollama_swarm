import {
  checkThinkStream,
  createThinkGuardSession,
  type ThinkGuardSession,
} from "@ollama-swarm/shared/streamThinkGuard";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";

export type PromptGuardOpts = {
  wallClockMs?: number;
  refereeOn?: boolean;
  minThinkCharsForReferee?: number;
  activityKind?: string;
  /** Reuse session for continuation prompts (budgetExtended may already be set). */
  session?: ThinkGuardSession;
};

export function composePromptGuardSignals(
  parent: AbortSignal,
  opts: PromptGuardOpts = {},
): {
  signal: AbortSignal;
  wrapOnChunk: (fn?: (text: string) => void) => ((text: string) => void) | undefined;
  cleanup: () => void;
  session: ThinkGuardSession;
} {
  const session = opts.session ?? createThinkGuardSession();
  const trip = new AbortController();
  const cleanups: Array<() => void> = [];

  if (opts.wallClockMs && opts.wallClockMs > 0) {
    const timer = setTimeout(() => {
      trip.abort(new Error(`prompt wall-clock exceeded ${opts.wallClockMs}ms`));
    }, opts.wallClockMs);
    cleanups.push(() => clearTimeout(timer));
  }

  const signal =
    typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any([parent, trip.signal])
      : parent;

  const refereeOn = opts.refereeOn === true;

  const wrapOnChunk = (fn?: (text: string) => void) => {
    if (!fn) return undefined;
    return (text: string) => {
      const hit = checkThinkStream(text, session, {
        refereeOn,
        minThinkCharsForReferee: opts.minThinkCharsForReferee,
      });
      if (hit) {
        session.lastTrip = hit;
        if (hit.tier === 1) session.softTierTripped = true;
        trip.abort(
          new ThinkGuardAbortError({
            tier: hit.tier,
            reason: hit.reason,
            partialText: session.cumulativeText,
            thinkChars: hit.metrics.thinkChars,
            thinkElapsedMs: hit.metrics.thinkElapsedMs,
            repetition: hit.metrics.repetition,
            activityKind: opts.activityKind,
          }),
        );
        return;
      }
      fn(text);
    };
  };

  return {
    signal,
    wrapOnChunk,
    session,
    cleanup: () => {
      for (const c of cleanups) c();
    },
  };
}

/** @deprecated Use composePromptGuardSignals */
export function composeThinkGuardSignal(parent: AbortSignal) {
  const g = composePromptGuardSignals(parent);
  return { signal: g.signal, wrapOnChunk: g.wrapOnChunk };
}