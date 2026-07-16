/**
 * Shared "was this cycle productive?" signal for autonomous settlement.
 * Used by council audit and blackboard tier stuck gates.
 *
 * Durable progress (resets zero-progress streak / justifies open-ended continue):
 *   - commits this cycle
 *   - criteria met flips that are NOT skip-only promotions
 *   - ambition tier promotion installed
 *
 * Non-durable activity (does NOT reset streak):
 *   - new todos enqueued alone (auditor/stretch/planner can thrash forever)
 *   - skip→met promotions without commits (disk may still be wrong)
 */

export interface ProductiveCycleSignals {
  /** Criteria that flipped unmet → met this cycle (all sources). */
  metFlips: number;
  /** Ledger / git commits that advanced work this cycle. */
  commitsThisCycle: number;
  /**
   * New todos enqueued this cycle. Counted for logging / activity only —
   * does **not** count as durable progress (prevents stretch/audit spin).
   */
  newTodos: number;
  /** Ambition tier promotion succeeded. */
  tierPromoted?: boolean;
  /**
   * Subset of metFlips that came only from worker skip reconciliation
   * ("already done") without a commit. Subtracted from durable met flips.
   */
  skipOnlyMetFlips?: number;
}

/** Met flips that represent real settlement (not skip-only promotion). */
export function durableMetFlips(s: ProductiveCycleSignals): number {
  return Math.max(0, (s.metFlips ?? 0) - (s.skipOnlyMetFlips ?? 0));
}

/**
 * True when the cycle made durable progress worth resetting the autonomous
 * zero-progress streak. Board thrash (new todos / skip-met only) is not enough.
 */
export function isDurableProgress(s: ProductiveCycleSignals): boolean {
  return (
    durableMetFlips(s) > 0
    || (s.commitsThisCycle ?? 0) > 0
    || s.tierPromoted === true
  );
}

/**
 * Alias used by call sites: autonomous gates treat "productive" as durable.
 * Prefer isDurableProgress in new code.
 */
export function isProductiveCycle(s: ProductiveCycleSignals): boolean {
  return isDurableProgress(s);
}

/** True when the cycle did *something* (for logs only). */
export function isActiveCycle(s: ProductiveCycleSignals): boolean {
  return (
    isDurableProgress(s)
    || (s.newTodos ?? 0) > 0
    || (s.skipOnlyMetFlips ?? 0) > 0
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
  return (
    `no-productive-progress: ${streak} cycle(s) without commits, durable met flips, or tier promotion`
  );
}

/** Max stretch waves per autonomous council run (after all-met / empty planner). */
export const MAX_STRETCH_WAVES_PER_RUN = 1;
