/**
 * Council cycle execution settlement: do not advance past execution until
 * todos are completed or exhausted (failed/skipped by all execution agents).
 */

import type { QueuedTodo, TodoQueue } from "./blackboard/TodoQueue.js";
import { isJustifiedPermanentSkip } from "@ollama-swarm/shared/skipClassify";

/**
 * Structured permanent-skip codes (prefix). Free-text reasons may also
 * match legacy regexes in isPermanentSkipReason.
 */
export type PermanentSkipCode =
  | "already-done"
  | "out-of-scope"
  | "wont-do"
  | "not-applicable"
  | "run-stopping"
  | "noop-exhausted"
  | "attempts-exhausted";

export function permanentSkipReason(
  code: PermanentSkipCode,
  detail?: string,
): string {
  const base = `permanent:${code}`;
  return detail ? `${base}: ${detail}` : base;
}

/** True when fail/skip reason is a no-op / zero-write apply failure. */
export function isNoopApplyReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    /no file changes|no-op elided|wrote zero files|zero files|no-op\)/i.test(reason)
    || /search.?replace was a no-op/i.test(reason)
  );
}

/**
 * Skip reasons that mean "work is done / out of scope" — do not requeue.
 * Uses shared skipClassify for free-text + permanent: prefixes (including
 * worker-emitted permanent:already-done after classifyWorkerSkip).
 */
export function isPermanentSkipReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (/\brun stopping\b/i.test(reason)) return true;
  if (/^permanent:(?:noop-exhausted|attempts-exhausted)\b/i.test(reason)) return true;
  return isJustifiedPermanentSkip(reason);
}

export function maxAttemptsForCycle(executionAgentCount: number): number {
  // Each execution agent at least once; at least 2 tries even with a single worker.
  return Math.max(2, executionAgentCount);
}

export interface SettlementAttemptBook {
  /** todoId → set of worker ids that already finished a fail/skip attempt */
  attempts: Map<string, Set<string>>;
  /** todoId → recent fail/skip reason strings (for noop-exhausted detection) */
  failReasons: Map<string, string[]>;
}

export function createSettlementBook(): SettlementAttemptBook {
  return { attempts: new Map(), failReasons: new Map() };
}

export function recordSettlementAttempt(
  book: SettlementAttemptBook,
  todoId: string,
  workerId: string,
  reason?: string,
): void {
  let set = book.attempts.get(todoId);
  if (!set) {
    set = new Set();
    book.attempts.set(todoId, set);
  }
  set.add(workerId);
  if (reason) {
    let reasons = book.failReasons.get(todoId);
    if (!reasons) {
      reasons = [];
      book.failReasons.set(todoId, reasons);
    }
    reasons.push(reason);
    // Cap history
    if (reasons.length > 12) reasons.splice(0, reasons.length - 12);
  }
}

/**
 * After enough identical no-op apply fails, convert to permanent skip
 * so settlement does not spin agents forever.
 */
export function shouldPermanentSkipNoopExhausted(
  book: SettlementAttemptBook,
  todoId: string,
  minIdentical = 3,
): boolean {
  const reasons = book.failReasons.get(todoId) ?? [];
  if (reasons.length < minIdentical) return false;
  const tail = reasons.slice(-minIdentical);
  return tail.every((r) => isNoopApplyReason(r));
}

/**
 * Re-open failed / soft-skipped todos for another pass when not yet tried by
 * enough agents. Returns number of todos requeued to pending.
 * On exhaustion of no-op fails, converts to permanent skip.
 */
export function requeueUnresolvedCouncilTodos(
  queue: TodoQueue,
  executionAgentIds: readonly string[],
  book: SettlementAttemptBook,
  opts?: { maxAttempts?: number },
): { requeued: number; exhausted: string[]; permanentSkipped: string[] } {
  const maxAttempts = opts?.maxAttempts ?? maxAttemptsForCycle(executionAgentIds.length);
  let requeued = 0;
  const exhausted: string[] = [];
  const permanentSkipped: string[] = [];

  for (const t of queue.list()) {
    if (t.status === "completed" || t.status === "pending" || t.status === "in-progress") {
      continue;
    }
    if (t.status === "pending-commit") continue;

    if (t.status === "skipped" && isPermanentSkipReason(t.reason)) {
      continue;
    }

    if (t.status !== "failed" && t.status !== "skipped") continue;

    // Promote repeated no-op fails to permanent skip before requeue.
    if (t.status === "failed" && shouldPermanentSkipNoopExhausted(book, t.id)) {
      try {
        queue.skip(
          t.id,
          permanentSkipReason("noop-exhausted", t.reason ?? "repeated no-op apply"),
        );
        permanentSkipped.push(t.id);
        continue;
      } catch {
        /* fall through */
      }
    }

    const tried = book.attempts.get(t.id) ?? new Set<string>();
    // Count distinct workers + queue.retries (reaper/fail increments retries).
    const attemptCount = Math.max(tried.size, t.retries);

    if (attemptCount >= maxAttempts) {
      // Convert exhausted failed to permanent skip so cycle can settle.
      if (t.status === "failed") {
        try {
          queue.skip(
            t.id,
            permanentSkipReason(
              "attempts-exhausted",
              t.reason ?? `${attemptCount} attempts`,
            ),
          );
          permanentSkipped.push(t.id);
          continue;
        } catch {
          exhausted.push(t.id);
          continue;
        }
      }
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

  return { requeued, exhausted, permanentSkipped };
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
