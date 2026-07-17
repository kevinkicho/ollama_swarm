/**
 * Empty-execution / empty-standup dead-loop guard (RR-D).
 * Pure streak logic — callers emit system lines and decide stop vs reconfig.
 */

/** Consecutive empty execution cycles before reconfig/stop signal. */
export const EMPTY_EXECUTION_LIMIT = 3;

export function updateEmptyExecutionStreak(
  prev: number,
  empty: boolean,
  limit: number = EMPTY_EXECUTION_LIMIT,
): { streak: number; shouldAct: boolean } {
  if (!empty) return { streak: 0, shouldAct: false };
  const streak = prev + 1;
  return { streak, shouldAct: streak >= limit };
}

export function formatEmptyExecutionReason(streak: number): string {
  return (
    `empty-execution: ${streak} consecutive cycle(s) with 0 standup todos enqueued ` +
    `(no proposals / no fallback drafts)`
  );
}

/** Blackboard / planner empty-plan reason (parity with council empty-execution). */
export function formatEmptyPlanReason(streak: number): string {
  return (
    `empty-plan: ${streak} consecutive cycle(s) with 0 actionable todos ` +
    `(planner produced no executable work)`
  );
}
