/**
 * Council cycle execution settlement: do not advance past execution until
 * todos are completed or exhausted (failed/skipped by all execution agents).
 */

import type { QueuedTodo, TodoQueue } from "./blackboard/TodoQueue.js";

/** Skip reasons that mean "work is done / out of scope" — do not requeue. */
export function isPermanentSkipReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    /\balready\b/i.test(reason)
    && /\b(present|done|exist|fixed|applied|in the file|no changes)\b/i.test(reason)
  )
    || /\bno changes needed\b/i.test(reason)
    || /\bout of scope\b/i.test(reason)
    || /\bwont-?do\b/i.test(reason)
    || /\bwon't do\b/i.test(reason)
    || /\bnot applicable\b/i.test(reason)
    || /\brun stopping\b/i.test(reason);
}

export function maxAttemptsForCycle(executionAgentCount: number): number {
  // Each execution agent at least once; at least 2 tries even with a single worker.
  return Math.max(2, executionAgentCount);
}

export interface SettlementAttemptBook {
  /** todoId → set of worker ids that already finished a fail/skip attempt */
  attempts: Map<string, Set<string>>;
}

export function createSettlementBook(): SettlementAttemptBook {
  return { attempts: new Map() };
}

export function recordSettlementAttempt(
  book: SettlementAttemptBook,
  todoId: string,
  workerId: string,
): void {
  let set = book.attempts.get(todoId);
  if (!set) {
    set = new Set();
    book.attempts.set(todoId, set);
  }
  set.add(workerId);
}

/**
 * Re-open failed / soft-skipped todos for another pass when not yet tried by
 * enough agents. Returns number of todos requeued to pending.
 */
export function requeueUnresolvedCouncilTodos(
  queue: TodoQueue,
  executionAgentIds: readonly string[],
  book: SettlementAttemptBook,
  opts?: { maxAttempts?: number },
): { requeued: number; exhausted: string[] } {
  const maxAttempts = opts?.maxAttempts ?? maxAttemptsForCycle(executionAgentIds.length);
  let requeued = 0;
  const exhausted: string[] = [];

  for (const t of queue.list()) {
    if (t.status === "completed" || t.status === "pending" || t.status === "in-progress") {
      continue;
    }
    if (t.status === "pending-commit") continue;

    if (t.status === "skipped" && isPermanentSkipReason(t.reason)) {
      continue;
    }

    if (t.status !== "failed" && t.status !== "skipped") continue;

    const tried = book.attempts.get(t.id) ?? new Set<string>();
    // Count distinct workers + queue.retries (reaper/fail increments retries).
    const attemptCount = Math.max(tried.size, t.retries);

    if (attemptCount >= maxAttempts) {
      exhausted.push(t.id);
      continue;
    }

    try {
      queue.reopenForRetry(t.id);
      requeued++;
    } catch {
      // ignore
    }
  }

  return { requeued, exhausted };
}

/** True when no pending/in-progress work remains for this cycle. */
export function cycleExecutionSettled(queue: TodoQueue): boolean {
  const c = queue.counts();
  return c.pending === 0 && c.inProgress === 0 && c.pendingCommit === 0;
}

export function summarizeUnresolved(queue: TodoQueue): string {
  const failed = queue.list().filter((t) => t.status === "failed");
  const skipped = queue.list().filter((t) => t.status === "skipped");
  const parts: string[] = [];
  if (failed.length) {
    parts.push(
      `${failed.length} failed (${failed.map((t) => t.id).join(", ")})`,
    );
  }
  if (skipped.length) {
    const soft = skipped.filter((t) => !isPermanentSkipReason(t.reason));
    const hard = skipped.filter((t) => isPermanentSkipReason(t.reason));
    if (hard.length) parts.push(`${hard.length} permanent-skip`);
    if (soft.length) parts.push(`${soft.length} soft-skip`);
  }
  return parts.join(", ") || "none";
}

export type { QueuedTodo };
