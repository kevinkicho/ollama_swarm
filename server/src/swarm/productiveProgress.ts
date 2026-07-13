/**
 * Shared "was this cycle productive?" signal for autonomous settlement.
 * Used by council audit and (optionally) blackboard tier stuck gates.
 */

export interface ProductiveCycleSignals {
  /** Criteria that flipped unmet → met this cycle. */
  metFlips: number;
  /** Ledger / git commits that advanced work this cycle. */
  commitsThisCycle: number;
  /** New todos enqueued for unmet work this cycle. */
  newTodos: number;
  /** Ambition tier promotion succeeded. */
  tierPromoted?: boolean;
}

/** True when the cycle made real progress worth continuing autonomous work. */
export function isProductiveCycle(s: ProductiveCycleSignals): boolean {
  return (
    (s.metFlips ?? 0) > 0
    || (s.commitsThisCycle ?? 0) > 0
    || (s.newTodos ?? 0) > 0
    || s.tierPromoted === true
  );
}

/** Default consecutive zero-progress cycles before autonomous hard-stop. */
export const DEFAULT_ZERO_PROGRESS_LIMIT = 3;

/**
 * Update a zero-progress streak.
 * Returns the new streak and whether the run should stop.
 */
export function updateZeroProgressStreak(
  prev: number,
  productive: boolean,
  limit: number = DEFAULT_ZERO_PROGRESS_LIMIT,
): { streak: number; shouldStop: boolean } {
  if (productive) return { streak: 0, shouldStop: false };
  const streak = prev + 1;
  return { streak, shouldStop: streak >= limit };
}

export function formatNoProductiveProgressReason(streak: number): string {
  return `no-productive-progress: ${streak} cycle(s) without commits, met flips, or new todos`;
}
