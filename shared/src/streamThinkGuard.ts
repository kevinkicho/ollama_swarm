import { extractThinkTags } from "./extractThinkTags.js";
import { isDominantStreamLoop } from "./streamLoopDetect.js";
import type { ThinkGuardSession, ThinkGuardTrip, ThinkGuardTripMetrics } from "./thinkGuardErrors.js";

export { createThinkGuardSession } from "./thinkGuardErrors.js";
export type { ThinkGuardSession, ThinkGuardTrip } from "./thinkGuardErrors.js";

/** Hard abort think-only streams before they grow into multi-minute loops. */
export const THINK_STREAM_HARD_MAX_CHARS = 160_000;
/**
 * Absolute ceiling on cumulative stream text (think + final).
 * Run 9f449937 agent-3 grew to ~299k over ~4 min of continuous deltas while
 * idle-wall kept resetting — fail-closed well before multi-minute loops.
 */
export const STREAM_HARD_MAX_TOTAL_CHARS = 120_000;
/**
 * Min final-text length before suffix/phrase loop is a hard abort.
 * At ~20k the 9f449937 loop already had 100+ identical phrases.
 */
export const FINAL_STREAM_REP_MIN_CHARS = 12_000;
/**
 * Idle MS without a new stream chunk while still think-only.
 * While the provider keeps streaming, this clock resets — absolute ceiling
 * is THINK_STREAM_HARD_ABSOLUTE_MAX_MS.
 */
export const THINK_STREAM_HARD_MAX_MS = 120_000;
/** Absolute ceiling even when chunks keep arriving (safety net). */
export const THINK_STREAM_HARD_ABSOLUTE_MAX_MS = 600_000;

/** Soft tier — referee checkpoint when flag on (70% of hard idle). */
export const THINK_STREAM_SOFT_MAX_CHARS = 112_000;
export const THINK_STREAM_SOFT_MAX_MS = 84_000;
export const THINK_STREAM_SOFT_ABSOLUTE_MAX_MS = 420_000;

export const THINK_STREAM_SOFT_MIN_THINK_FOR_MS = 5_000;
export const THINK_STREAM_BUDGET_EXTEND_CHARS_RATIO = 0.4;
export const THINK_STREAM_BUDGET_EXTEND_MS_RATIO = 0.6;

/** @deprecated Use THINK_STREAM_HARD_MAX_CHARS */
export const THINK_STREAM_MAX_CHARS = THINK_STREAM_HARD_MAX_CHARS;
/** @deprecated Use THINK_STREAM_HARD_MAX_MS */
export const THINK_STREAM_MAX_MS = THINK_STREAM_HARD_MAX_MS;

export function detectRepetitiveTail(
  text: string,
  minLen = 30,
  maxLen = 200,
): { repeats: number; rLen: number } | null {
  return detectRepetitiveTailHard(text, { minLen, maxLen, minThinkLen: 0, minRepeats: 5, includeLineRepeat: true });
}

/** Suffix-repeat only; ignores 3-identical-lines until thinkLen >= minThinkLen. */
export function detectRepetitiveTailSoft(
  thoughts: string,
  opts = { minRepeats: 3, minThinkLen: 8_000, minSuffixLen: 30, maxSuffixLen: 200 },
): { repeats: number; rLen: number } | null {
  if (thoughts.trim().length < opts.minThinkLen) return null;
  return detectSuffixRepeat(thoughts, opts.minSuffixLen, opts.maxSuffixLen, opts.minRepeats);
}

export function detectRepetitiveTailHard(
  text: string,
  opts: {
    minLen?: number;
    maxLen?: number;
    minThinkLen?: number;
    minRepeats?: number;
    includeLineRepeat?: boolean;
  } = {},
): { repeats: number; rLen: number } | null {
  const minThinkLen = opts.minThinkLen ?? 10_000;
  if (text.trim().length < minThinkLen && minThinkLen > 0) return null;
  if (opts.includeLineRepeat !== false && text.length >= 200) {
    const lines = text.split("\n").filter(Boolean);
    if (lines.length >= 3) {
      const last3 = lines.slice(-3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        return { repeats: 3, rLen: last3[0].length };
      }
    }
  }
  return detectSuffixRepeat(
    text,
    opts.minLen ?? 30,
    opts.maxLen ?? 200,
    opts.minRepeats ?? 5,
  );
}

function detectSuffixRepeat(
  text: string,
  minLen: number,
  maxLen: number,
  minRepeats: number,
): { repeats: number; rLen: number } | null {
  if (text.length < 200) return null;
  for (let rLen = maxLen; rLen >= minLen; rLen--) {
    const tail = text.slice(-rLen);
    let count = 0;
    let pos = text.length;
    while (pos >= rLen && text.slice(pos - rLen, pos) === tail) {
      count++;
      pos -= rLen;
    }
    if (count >= minRepeats) return { repeats: count, rLen };
  }
  return null;
}

function thinkMetrics(raw: string, session: ThinkGuardSession): ThinkGuardTripMetrics | null {
  const { thoughts, finalText } = extractThinkTags(raw);
  const thinkLen = thoughts.trim().length;
  const postThink = finalText.trim();
  const thinkOnly =
    thinkLen > 0
    && (postThink.length === 0 || postThink === raw.trim() || postThink.includes("</think>"));
  if (!thinkOnly) return null;
  const rep = detectRepetitiveTailHard(thoughts);
  return {
    thinkChars: thinkLen,
    thinkElapsedMs: Math.max(0, Date.now() - session.startedAt),
    repetition: rep,
  };
}

/** Think chars inside tags even when the stream also has tool output or draft JSON. */
export function thinkCharCountInStream(raw: string): number {
  return extractThinkTags(raw).thoughts.trim().length;
}

function mixedStreamSoftTrip(
  raw: string,
  session: ThinkGuardSession,
  minThinkChars: number,
): ThinkGuardTrip | null {
  const thoughts = extractThinkTags(raw).thoughts;
  const thinkLen = thoughts.trim().length;
  if (thinkLen < minThinkChars) return null;
  const elapsed = Math.max(0, Date.now() - session.startedAt);
  const lim = effectiveLimits(session);
  const rep = detectRepetitiveTailSoft(thoughts);
  const metrics: ThinkGuardTripMetrics = {
    thinkChars: thinkLen,
    thinkElapsedMs: elapsed,
    repetition: rep,
  };
  if (thinkLen >= lim.softChars) {
    return makeTrip(
      1,
      `think block exceeded ${lim.softChars.toLocaleString()} chars (soft, mixed stream)`,
      metrics,
    );
  }
  if (thinkLen > THINK_STREAM_SOFT_MIN_THINK_FOR_MS && elapsed >= lim.softMs) {
    return makeTrip(
      1,
      `long think block exceeded ${Math.round(lim.softMs / 1000)}s (soft, mixed stream)`,
      metrics,
    );
  }
  if (rep) {
    return makeTrip(
      1,
      `repetitive reasoning in think block (${rep.repeats}×${rep.rLen} char tail, soft, mixed)`,
      metrics,
    );
  }
  return null;
}

function makeTrip(tier: 1 | 2, reason: string, metrics: ThinkGuardTripMetrics): ThinkGuardTrip {
  return { tier, reason, metrics };
}

function idleMs(session: ThinkGuardSession): number {
  return Math.max(0, Date.now() - (session.lastChunkAt || session.startedAt));
}

export function checkSoft(raw: string, session: ThinkGuardSession): ThinkGuardTrip | null {
  const metrics = thinkMetrics(raw, session);
  if (!metrics) return null;
  const lim = effectiveLimits(session);

  if (metrics.thinkChars >= lim.softChars) {
    return makeTrip(1, `think stream exceeded ${lim.softChars.toLocaleString()} chars (soft)`, metrics);
  }
  // Time trips use idle-since-last-chunk when the stream is still producing
  // tokens; absolute ceiling still applies for runaway streams.
  if (metrics.thinkChars > THINK_STREAM_SOFT_MIN_THINK_FOR_MS) {
    if (metrics.thinkElapsedMs >= lim.softAbsoluteMs) {
      return makeTrip(
        1,
        `think-only stream exceeded ${Math.round(lim.softAbsoluteMs / 1000)}s absolute (soft)`,
        metrics,
      );
    }
    if (idleMs(session) >= lim.softMs) {
      return makeTrip(
        1,
        `think-only stream idle ${Math.round(lim.softMs / 1000)}s without new chunks (soft)`,
        metrics,
      );
    }
  }
  const repSoft = detectRepetitiveTailSoft(
    extractThinkTags(raw).thoughts,
  );
  if (repSoft) {
    return makeTrip(
      1,
      `repetitive reasoning loop (${repSoft.repeats}×${repSoft.rLen} char tail, soft)`,
      { ...metrics, repetition: repSoft },
    );
  }
  return null;
}

function finalStreamHardTrip(raw: string, session: ThinkGuardSession): ThinkGuardTrip | null {
  const { thoughts, finalText } = extractThinkTags(raw);
  const elapsed = Math.max(0, Date.now() - session.startedAt);
  const baseMetrics: ThinkGuardTripMetrics = {
    thinkChars: thoughts.trim().length,
    thinkElapsedMs: elapsed,
    repetition: null,
  };

  // Total-size ceiling targets mixed/final bloat (9f449937). Pure think-only
  // streams still use THINK_STREAM_HARD_MAX_CHARS (160k) below — don't trip
  // a long but healthy think block early.
  // Note: extractThinkTags falls back to raw when final is empty, so treat
  // "finalText === raw with non-empty thoughts" as think-only.
  const thinkLen = thoughts.trim().length;
  const postThink = finalText.trim();
  const thinkOnly =
    thinkLen > 0
    && (postThink.length === 0 || postThink === raw.trim() || postThink.includes("</think>"));
  if (
    !thinkOnly
    && raw.length >= STREAM_HARD_MAX_TOTAL_CHARS
    && postThink.length >= FINAL_STREAM_REP_MIN_CHARS
  ) {
    return makeTrip(
      2,
      `stream exceeded ${STREAM_HARD_MAX_TOTAL_CHARS.toLocaleString()} total chars (think+final)`,
      baseMetrics,
    );
  }

  // Phrase-loop detector works on full raw (think+final) — catches loops that
  // leak </think> into content and then spin (9f449937).
  const loop = isDominantStreamLoop(raw, {
    minLen: FINAL_STREAM_REP_MIN_CHARS,
    minRatio: 0.4,
    minCount: 6,
  });
  if (loop) {
    return makeTrip(
      2,
      `repetitive stream loop (${loop.count}×${loop.phraseLen} char phrase, ` +
        `${Math.round(loop.coveredRatio * 100)}% coverage, ${raw.length.toLocaleString()} total chars)`,
      {
        ...baseMetrics,
        repetition: { repeats: loop.count, rLen: loop.phraseLen },
      },
    );
  }

  const final = finalText.trim();
  if (final.length < FINAL_STREAM_REP_MIN_CHARS) return null;
  const rep = detectRepetitiveTailHard(final, {
    minThinkLen: FINAL_STREAM_REP_MIN_CHARS,
    minRepeats: 5,
    includeLineRepeat: true,
  });
  if (!rep) return null;
  return makeTrip(
    2,
    `repetitive final-text loop (${rep.repeats}×${rep.rLen} char tail, ${final.length.toLocaleString()} final chars)`,
    { ...baseMetrics, repetition: rep },
  );
}

export function checkHard(raw: string, session: ThinkGuardSession): ThinkGuardTrip | null {
  // Always enforce total-size + final-text loops, even when not think-only.
  const finalTrip = finalStreamHardTrip(raw, session);
  if (finalTrip) return finalTrip;

  const metrics = thinkMetrics(raw, session);
  if (!metrics) return null;
  const lim = effectiveLimits(session);

  if (metrics.thinkChars >= lim.hardChars) {
    return makeTrip(2, `think stream exceeded ${lim.hardChars.toLocaleString()} chars`, metrics);
  }
  if (metrics.thinkChars > THINK_STREAM_SOFT_MIN_THINK_FOR_MS) {
    if (metrics.thinkElapsedMs >= lim.hardAbsoluteMs) {
      return makeTrip(
        2,
        `think-only stream exceeded ${Math.round(lim.hardAbsoluteMs / 1000)}s absolute`,
        metrics,
      );
    }
    if (idleMs(session) >= lim.hardMs) {
      return makeTrip(
        2,
        `think-only stream idle ${Math.round(lim.hardMs / 1000)}s without new chunks`,
        metrics,
      );
    }
  }
  const rep = detectRepetitiveTailHard(extractThinkTags(raw).thoughts);
  if (rep) {
    return makeTrip(
      2,
      `repetitive reasoning loop (${rep.repeats}×${rep.rLen} char tail)`,
      { ...metrics, repetition: rep },
    );
  }
  return null;
}

function effectiveLimits(session: ThinkGuardSession): {
  softChars: number;
  hardChars: number;
  softMs: number;
  hardMs: number;
  softAbsoluteMs: number;
  hardAbsoluteMs: number;
} {
  const charMul = session.budgetExtended ? 1 + THINK_STREAM_BUDGET_EXTEND_CHARS_RATIO : 1;
  const msMul = session.budgetExtended ? 1 + THINK_STREAM_BUDGET_EXTEND_MS_RATIO : 1;
  return {
    softChars: Math.round(THINK_STREAM_SOFT_MAX_CHARS * charMul),
    hardChars: Math.round(THINK_STREAM_HARD_MAX_CHARS * charMul),
    softMs: Math.round(THINK_STREAM_SOFT_MAX_MS * msMul),
    hardMs: Math.round(THINK_STREAM_HARD_MAX_MS * msMul),
    softAbsoluteMs: Math.round(THINK_STREAM_SOFT_ABSOLUTE_MAX_MS * msMul),
    hardAbsoluteMs: Math.round(THINK_STREAM_HARD_ABSOLUTE_MAX_MS * msMul),
  };
}

function shouldRunSoftTier(
  raw: string,
  session: ThinkGuardSession,
  minThinkCharsForReferee: number,
): boolean {
  const metrics = thinkMetrics(raw, session);
  if (!metrics) return false;
  if (metrics.thinkChars >= minThinkCharsForReferee) return true;
  return metrics.repetition != null;
}

export function checkThinkStream(
  raw: string,
  session: ThinkGuardSession,
  opts: { refereeOn: boolean; minThinkCharsForReferee?: number },
): ThinkGuardTrip | null {
  session.cumulativeText = raw;
  session.lastChunkAt = Date.now();
  if (!opts.refereeOn) return checkHard(raw, session);
  const minThink = opts.minThinkCharsForReferee ?? 30_000;
  if (shouldRunSoftTier(raw, session, minThink)) {
    const soft = checkSoft(raw, session);
    if (soft) return soft;
  }
  // Tool-heavy planner explore: visible output exists but think block still grows unbounded.
  const mixed = mixedStreamSoftTrip(raw, session, minThink);
  if (mixed) return mixed;
  return checkHard(raw, session);
}

/** Legacy guard — hard tier only (flag-off behavior). */
export function createThinkStreamGuard(startedAt = Date.now()) {
  const session: ThinkGuardSession = {
    startedAt,
    lastChunkAt: startedAt,
    cumulativeText: "",
    softTierTripped: false,
    budgetExtended: false,
    refereeInvocations: 0,
  };
  return {
    session,
    check(raw: string): string | null {
      const trip = checkHard(raw, session);
      if (trip) {
        session.lastTrip = trip;
        return trip.reason;
      }
      return null;
    },
  };
}