import type { ExitCriterion } from "./blackboard/types.js";

export interface SkipEvidenceTodo {
  criterionId?: string;
  criteriaIds?: readonly string[];
  reason?: string;
  expectedFiles: readonly string[];
}

/** True when a worker skip reason indicates the work is already satisfied. */
export function isAlreadyDoneSkipReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return /\b(already\s+(present|implemented|done|exists|complete)|no\s+changes?\s+needed|nothing\s+to\s+do|work\s+already|content\s+already|feature\s+already)\b/.test(
    lower,
  );
}

/**
 * Promote unmet contract criteria to met when linked todos were skipped with
 * an "already done" reason. Falls back to expectedFiles overlap when no
 * criterionId is wired.
 */
export function reconcileCriteriaFromSkips(
  criteria: ExitCriterion[],
  skippedTodos: readonly SkipEvidenceTodo[],
): { criteria: ExitCriterion[]; promotedIds: string[] } {
  const metIds = new Set<string>();

  for (const todo of skippedTodos) {
    if (!todo.reason || !isAlreadyDoneSkipReason(todo.reason)) continue;

    const linkedIds =
      todo.criteriaIds && todo.criteriaIds.length > 0
        ? [...todo.criteriaIds]
        : todo.criterionId
          ? [todo.criterionId]
          : [];

    for (const id of linkedIds) {
      metIds.add(id);
    }

    if (linkedIds.length === 0 && todo.expectedFiles.length > 0) {
      const todoFiles = new Set(todo.expectedFiles);
      for (const c of criteria) {
        if (c.status !== "unmet") continue;
        if (c.expectedFiles.some((f) => todoFiles.has(f))) {
          metIds.add(c.id);
        }
      }
    }
  }

  if (metIds.size === 0) {
    return { criteria, promotedIds: [] };
  }

  const promotedIds: string[] = [];
  const updated = criteria.map((c) => {
    if (c.status === "unmet" && metIds.has(c.id)) {
      promotedIds.push(c.id);
      return {
        ...c,
        status: "met" as const,
        rationale: "Worker skip: work already present",
      };
    }
    return c;
  });

  return { criteria: updated, promotedIds };
}