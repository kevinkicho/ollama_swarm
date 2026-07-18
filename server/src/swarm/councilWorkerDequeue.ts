/**
 * Council worker dequeue — file-scoped deferral + hotspot soft scoring.
 * Extracted from councilWorkerRunner for unit-testability and LOC hygiene.
 */

import type { TodoQueue, QueuedTodo } from "./blackboard/TodoQueue.js";
import { scoreCouncilTodoForDequeue } from "./councilTodoPlan.js";

/**
 * Dequeue with file-scoped deferral: at most one in-flight writer per
 * expectedFiles path. Soft-deprioritizes basename hotspots via fileFailStreak.
 */
export function dequeueCouncilTodo(
  queue: TodoQueue,
  workerId: string,
  fileFailStreak?: ReadonlyMap<string, number>,
): QueuedTodo | null {
  const all = queue.list();
  const inProgress = all.filter((t) => t.status === "in-progress");
  const hasPendingOrActiveNonBuild = all.some(
    (t) => (t.status === "pending" || t.status === "in-progress") && t.kind !== "build",
  );

  const scoreOpts = {
    fileFailStreak,
    hasNonHotspotPending: undefined as boolean | undefined,
  };
  if (fileFailStreak && fileFailStreak.size > 0) {
    scoreOpts.hasNonHotspotPending = all.some((t) => {
      if (t.status !== "pending") return false;
      const s = scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild, {
        fileFailStreak,
        hasNonHotspotPending: false,
      });
      return s > Number.NEGATIVE_INFINITY;
    });
  }

  let best: (typeof all)[number] | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const t of all) {
    if (t.status !== "pending") continue;
    const score = scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild, scoreOpts);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best || bestScore === Number.NEGATIVE_INFINITY) return null;
  return queue.dequeueByScore(workerId, (t) =>
    scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild, scoreOpts),
  );
}
