import {
  checkThinkStream,
  createThinkGuardSession,
  type ThinkGuardSession,
} from "@ollama-swarm/shared/streamThinkGuard";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";
import { sniffJsonFormatStream } from "@ollama-swarm/shared/jsonFormatSniff";

export type PromptGuardOpts = {
  /** Idle wall-clock: resets on each stream chunk (provider still talking). */
  wallClockMs?: number;
  /**
   * Absolute hard ceiling from prompt start — never resets on chunks.
   * Fail-closed for runaway continuous streams that would never hit idle timeout.
   * Default: max(5 × wallClockMs, 10 min) when wallClockMs set; else 15 min.
   */
  absoluteMaxMs?: number;
  /**
   * @deprecated Soft-tier referee retired — always hard-only. Kept for call-site compat.
   */
  refereeOn?: boolean;
  /** @deprecated ignored — soft tier off */
  getRefereeOn?: () => boolean;
  /** @deprecated ignored */
  minThinkCharsForReferee?: number;
  /** @deprecated ignored */
  getMinThinkCharsForReferee?: () => number | undefined;
  activityKind?: string;
  /** Reuse session for continuation prompts (budgetExtended may already be set). */
  session?: ThinkGuardSession;
  /**
   * When "json", abort streams that never produce JSON markers (think-aware).
   * Was documented on formatExpect but never wired on the Ollama path
   * (run eee6718f: 12× primary failed on pure <think> with no JSON).
   */
  formatExpect?: "json" | "free";
};

/** Resolve absolute prompt ceiling (fail-closed hung/runaway stream). */
export function resolveAbsolutePromptMaxMs(
  wallClockMs?: number,
  absoluteMaxMs?: number,
): number {
  if (absoluteMaxMs != null && absoluteMaxMs > 0) return absoluteMaxMs;
  if (wallClockMs != null && wallClockMs > 0) {
    return Math.max(wallClockMs * 5, 600_000);
  }
  return 900_000; // 15 min default when no idle wall is configured
}

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

  // Absolute hard ceiling — does NOT reset on chunks. Without this, a model
  // that streams forever never trips the idle wall-clock.
  const absoluteMaxMs = resolveAbsolutePromptMaxMs(opts.wallClockMs, opts.absoluteMaxMs);
  const absoluteTimer = setTimeout(() => {
    trip.abort(
      new Error(
        `prompt absolute wall-clock exceeded ${absoluteMaxMs}ms (fail-closed hung prompt)`,
      ),
    );
  }, absoluteMaxMs);
  absoluteTimer.unref?.();
  cleanups.push(() => clearTimeout(absoluteTimer));

  const signal =
    typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any([parent, trip.signal])
      : parent;

  // Soft-tier LLM referee retired — always hard think caps only.
  void opts.refereeOn;
  void opts.getRefereeOn;
  void opts.minThinkCharsForReferee;
  void opts.getMinThinkCharsForReferee;

  let formatSniffDone = false;
  const wrapOnChunk = (fn?: (text: string) => void) => {
    if (!fn) return undefined;
    return (text: string) => {
      armWallClock(); // extend prompt wall-clock while provider is streaming
      const hit = checkThinkStream(text, session, {
        refereeOn: false,
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
      // Think-aware JSON format sniff (Ollama path — previously dead option).
      if (opts.formatExpect === "json" && !formatSniffDone) {
        const sniff = sniffJsonFormatStream(text);
        if (!sniff.ok) {
          formatSniffDone = true;
          trip.abort(
            new ThinkGuardAbortError({
              tier: 2,
              reason: sniff.reason,
              partialText: text,
              thinkChars: 0,
              thinkElapsedMs: Math.max(0, Date.now() - session.startedAt),
              activityKind: opts.activityKind,
            }),
          );
          return;
        }
        if (sniff.phase === "has_json") formatSniffDone = true;
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