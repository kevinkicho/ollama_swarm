import type { ExitCriterion } from "./blackboard/types.js";
import { canonicalizeExpectedFiles } from "./councilPathCanonicalize.js";

export interface SkipEvidenceTodo {
  criterionId?: string;
  criteriaIds?: readonly string[];
  reason?: string;
  expectedFiles: readonly string[];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(p: string): string {
  const parts = normalizePath(p).split("/");
  return parts[parts.length - 1] ?? p;
}

/** True when skip todo files overlap criterion files (exact or basename match). */
export function skipCoversCriterionFiles(
  skipFiles: readonly string[],
  criterionFiles: readonly string[],
): boolean {
  if (criterionFiles.length === 0) {
    return skipFiles.length > 0;
  }
  const skipNorm = new Set(skipFiles.map(normalizePath));
  const skipBases = new Set(skipFiles.map(basename));
  for (const f of criterionFiles) {
    const nf = normalizePath(f);
    if (skipNorm.has(nf)) return true;
    if (skipBases.has(basename(nf))) return true;
  }
  return false;
}

/** True when a worker skip reason indicates the work is already satisfied. */
export function isAlreadyDoneSkipReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return /\b(already\s+(present|implemented|done|exists|complete|contains)|no\s+(additional\s+content|changes?\s+needed)|nothing\s+to\s+do|work\s+already|content\s+already|feature\s+already|appears\s+complete|all\s+phases\s+already\s+have)\b/.test(
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
  repoFiles: readonly string[] = [],
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
      const todoFiles = canonicalizeExpectedFiles(todo.expectedFiles, repoFiles);
      const todoSet = new Set(todoFiles.map(normalizePath));
      const todoBases = new Set(todoFiles.map(basename));
      for (const c of criteria) {
        if (c.status !== "unmet") continue;
        const critFiles = canonicalizeExpectedFiles(c.expectedFiles, repoFiles);
        const overlaps =
          critFiles.some((f) => todoSet.has(normalizePath(f))) ||
          critFiles.some((f) => todoBases.has(basename(f)));
        if (overlaps) {
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

/** Drop audit todos that duplicate work workers already skipped as done. */
export function filterAuditTodosAgainstSkips<
  T extends { description: string; expectedFiles: readonly string[]; criterionId?: string },
>(newTodos: readonly T[], skipEvidence: readonly SkipEvidenceTodo[]): T[] {
  const doneSkips = skipEvidence.filter((s) => s.reason && isAlreadyDoneSkipReason(s.reason));
  if (doneSkips.length === 0) return [...newTodos];

  return newTodos.filter((t) => {
    return !doneSkips.some((s) => {
      if (t.criterionId && (s.criterionId === t.criterionId || s.criteriaIds?.includes(t.criterionId))) {
        return true;
      }
      return skipCoversCriterionFiles(s.expectedFiles, t.expectedFiles);
    });
  });
}

/** Promote criteria to met when skip evidence covers their files with an already-done reason. */
export function promoteCriteriaFromSkipEvidence(
  criteria: ExitCriterion[],
  skipEvidence: readonly SkipEvidenceTodo[],
): ExitCriterion[] {
  const doneSkips = skipEvidence.filter((s) => s.reason && isAlreadyDoneSkipReason(s.reason));
  if (doneSkips.length === 0) return criteria;

  return criteria.map((c) => {
    if (c.status !== "unmet") return c;
    const covered = doneSkips.some(
      (s) =>
        (s.criterionId === c.id || s.criteriaIds?.includes(c.id)) ||
        skipCoversCriterionFiles(s.expectedFiles, c.expectedFiles),
    );
    if (!covered) return c;
    return {
      ...c,
      status: "met" as const,
      rationale: "Worker skip: work already present",
    };
  });
}