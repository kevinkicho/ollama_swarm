import {
  checkThinkStream,
  createThinkGuardSession,
  type ThinkGuardSession,
} from "@ollama-swarm/shared/streamThinkGuard";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";

export type PromptGuardOpts = {
  wallClockMs?: number;
  refereeOn?: boolean;
  /**
   * Live re-read for mid-run reconfig (e.g. user turns referee on).
   * When set, each chunk uses the latest value instead of a frozen bool.
   */
  getRefereeOn?: () => boolean;
  minThinkCharsForReferee?: number;
  getMinThinkCharsForReferee?: () => number | undefined;
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

  // Streaming-aware prompt wall-clock: each chunk resets the timer so
  // long but actively streaming turns are not aborted at a fixed 120s.
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const armWallClock = () => {
    if (!opts.wallClockMs || opts.wallClockMs <= 0) return;
    if (wallTimer) clearTimeout(wallTimer);
    wallTimer = setTimeout(() => {
      trip.abort(new Error(`prompt wall-clock idle exceeded ${opts.wallClockMs}ms (no stream chunks)`));
    }, opts.wallClockMs);
  };
  armWallClock();
  cleanups.push(() => {
    if (wallTimer) clearTimeout(wallTimer);
  });

  const signal =
    typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any([parent, trip.signal])
      : parent;

  const resolveRefereeOn = () =>
    opts.getRefereeOn ? opts.getRefereeOn() === true : opts.refereeOn === true;

  const wrapOnChunk = (fn?: (text: string) => void) => {
    if (!fn) return undefined;
    return (text: string) => {
      armWallClock(); // extend prompt wall-clock while provider is streaming
      const hit = checkThinkStream(text, session, {
        refereeOn: resolveRefereeOn(),
        minThinkCharsForReferee:
          opts.getMinThinkCharsForReferee?.() ?? opts.minThinkCharsForReferee,
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