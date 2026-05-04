// Q8 (2026-05-04): pheromone decay + saturation cap for stigmergy.
//
// StigmergyRunner accumulates per-file annotations as
// `{visits, avgInterest, avgConfidence, latestNote}`. The current
// implementation has two issues:
//
//   1. **No interest decay.** Once a file gets a high `avgInterest`
//      score, it stays high — even after several rounds where it
//      surfaced no new findings. The swarm keeps re-visiting it.
//   2. **No saturation cap.** A single file can accumulate dozens of
//      visits if early rounds rated it high; later rounds get stuck
//      in a hot-spot loop.
//
// This module ships pure helpers:
//   - `decayInterest` — apply a multiplicative decay per-elapsed-round
//     so a file's interest fades toward 0 if not re-visited
//   - `isSaturated` — flag files that have hit MAX_REVISITS so the
//     picker filters them out
//   - `pickNextFileWithDecay` — deterministic picker that combines
//     decayed interest + saturation cap + tie-break by lowest visits
//
// Tradeoffs:
//   - Tuning the decay rate is a balance: too fast → swarm forgets
//     useful signals; too slow → no behavior change. Default 0.85
//     per-round (a high-interest file fades from 8 → ~0.5 over 20
//     unvisited rounds).
//   - Hot-spot files DO sometimes deserve repeated visits (e.g., a
//     core module that everything else routes through). Cap is at
//     MAX_REVISITS=8 to balance "don't loop" vs "let depth happen".

export interface PheromoneState {
  visits: number;
  avgInterest: number;
  avgConfidence: number;
  latestNote: string;
}

/** Multiplicative decay per elapsed round. 0.85 → high-interest file
 *  fades from 8 → ~0.5 over 20 unvisited rounds. */
export const DEFAULT_DECAY_RATE = 0.85;

/** Max times a single file can be visited before the saturation
 *  filter excludes it. Tuned to allow depth (re-read after planning)
 *  without permitting hot-spot loops. */
export const DEFAULT_MAX_REVISITS = 8;

/** Apply decay: returns a NEW state with decayed avgInterest. Pure;
 *  doesn't mutate input. `roundsElapsed` is rounds since the file
 *  was last visited; pass 0 (no decay) when the file IS being
 *  visited this round. */
export function decayInterest(
  state: PheromoneState,
  roundsElapsed: number,
  decayRate: number = DEFAULT_DECAY_RATE,
): PheromoneState {
  if (roundsElapsed <= 0) return { ...state };
  const decayed = state.avgInterest * Math.pow(decayRate, roundsElapsed);
  return { ...state, avgInterest: decayed };
}

/** Is this file at the saturation cap (no more visits allowed)? */
export function isSaturated(
  state: PheromoneState,
  maxRevisits: number = DEFAULT_MAX_REVISITS,
): boolean {
  return state.visits >= maxRevisits;
}

/** Pick the next file an agent should inspect, given the current
 *  pheromone table + the round number for decay calculations.
 *  Returns null when every candidate is saturated.
 *
 *  Picker scoring (highest wins):
 *    decayedInterest × confidence-adjusted-bonus
 *    - confidence ≥ 7: ×1.2 boost (we trust the prior signal)
 *    - confidence ≤ 3: ×0.5 dampen (low confidence = noise)
 *
 *  Tie-break: lowest visits (prefer less-explored files).
 *  Pure — exported for tests; runner threads round-elapsed counters. */
export function pickNextFileWithDecay(args: {
  candidates: ReadonlyArray<{
    path: string;
    state: PheromoneState;
    /** Round number when this file was last visited; null if never. */
    lastVisitedRound: number | null;
  }>;
  /** Current round; used as the time-zero for decay. */
  currentRound: number;
  decayRate?: number;
  maxRevisits?: number;
}): { path: string; score: number } | null {
  const { candidates, currentRound, decayRate, maxRevisits } = args;
  const cap = maxRevisits ?? DEFAULT_MAX_REVISITS;
  const eligible = candidates.filter((c) => !isSaturated(c.state, cap));
  if (eligible.length === 0) return null;
  let best: { path: string; score: number; visits: number } | null = null;
  for (const c of eligible) {
    const elapsed =
      c.lastVisitedRound === null ? 0 : currentRound - c.lastVisitedRound;
    const decayed = decayInterest(c.state, elapsed, decayRate);
    const confidenceBoost =
      c.state.avgConfidence >= 7
        ? 1.2
        : c.state.avgConfidence <= 3
          ? 0.5
          : 1.0;
    const score = decayed.avgInterest * confidenceBoost;
    if (
      !best ||
      score > best.score ||
      (score === best.score && c.state.visits < best.visits) ||
      (score === best.score &&
        c.state.visits === best.visits &&
        c.path < best.path)
    ) {
      best = { path: c.path, score, visits: c.state.visits };
    }
  }
  return best ? { path: best.path, score: best.score } : null;
}
