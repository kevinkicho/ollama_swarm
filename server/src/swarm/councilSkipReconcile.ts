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
  return /\b(already\s+(present|implemented|done|exists|complete|contains|applied)|all\s+changes?\s+(are\s+)?already|no\s+(additional\s+content|changes?\s+needed)|nothing\s+to\s+do|work\s+already|content\s+already|feature\s+already|appears\s+complete|all\s+phases\s+already\s+have|no\s+change\s+needed)\b/.test(
    lower,
  );
}

/**
 * When repo inventory is known, require at least one criterion expectedFile to
 * exist on disk (exact or basename) before skip→met. Prevents hallucinated
 * "already done" promotions for missing paths.
 *
 * Empty expectedFiles → never promote (no grounded target).
 * Empty repoFiles → cannot verify; require linked criterionId + file overlap
 * on the skip todo (stricter than promoting on reason alone).
 */
export function criterionGroundedForSkipPromote(
  criterion: ExitCriterion,
  skipFiles: readonly string[],
  repoFiles: readonly string[],
): boolean {
  if (criterion.expectedFiles.length === 0) {
    // No file targets — skip→met is too weak (pure prose "already done").
    return false;
  }

  if (repoFiles.length === 0) {
    // No inventory: id-linked skips with criterion file targets may promote;
    // otherwise require skip todo files to overlap the criterion.
    if (skipFiles.length === 0) return criterion.expectedFiles.length > 0;
    return skipCoversCriterionFiles(skipFiles, criterion.expectedFiles);
  }

  const repoNorm = new Set(repoFiles.map(normalizePath));
  const repoBases = new Set(repoFiles.map(basename));
  const critFiles = canonicalizeExpectedFiles(criterion.expectedFiles, repoFiles);
  // At least one expected path must exist in the repo inventory.
  const anyExists = critFiles.some((f) => {
    const nf = normalizePath(f);
    return repoNorm.has(nf) || repoBases.has(basename(nf));
  });
  if (!anyExists) return false;

  // Prefer overlap between skip files and criterion files when skip names files.
  if (skipFiles.length > 0) {
    return skipCoversCriterionFiles(skipFiles, critFiles);
  }
  // Linked-by-id skip without files: allow only if criterion files exist on disk.
  return true;
}

/**
 * Promote unmet contract criteria to met when linked todos were skipped with
 * an "already done" reason **and** files are grounded in the repo inventory.
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
      const c = criteria.find((x) => x.id === id);
      if (!c || c.status !== "unmet") continue;
      if (criterionGroundedForSkipPromote(c, todo.expectedFiles, repoFiles)) {
        metIds.add(id);
      }
    }

    if (linkedIds.length === 0 && todo.expectedFiles.length > 0) {
      const todoFiles = canonicalizeExpectedFiles(todo.expectedFiles, repoFiles);
      for (const c of criteria) {
        if (c.status !== "unmet") continue;
        if (!skipCoversCriterionFiles(todoFiles, c.expectedFiles)) continue;
        if (criterionGroundedForSkipPromote(c, todo.expectedFiles, repoFiles)) {
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
        rationale: "Worker skip: work already present (disk-grounded)",
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

/**
 * Promote criteria to met when skip evidence covers their files with an
 * already-done reason. Optional repoFiles enforces disk grounding.
 */
export function promoteCriteriaFromSkipEvidence(
  criteria: ExitCriterion[],
  skipEvidence: readonly SkipEvidenceTodo[],
  repoFiles: readonly string[] = [],
): ExitCriterion[] {
  const doneSkips = skipEvidence.filter((s) => s.reason && isAlreadyDoneSkipReason(s.reason));
  if (doneSkips.length === 0) return criteria;

  return criteria.map((c) => {
    if (c.status !== "unmet") return c;
    const covering = doneSkips.filter(
      (s) =>
        (s.criterionId === c.id || s.criteriaIds?.includes(c.id))
        || skipCoversCriterionFiles(s.expectedFiles, c.expectedFiles),
    );
    if (covering.length === 0) return c;
    const grounded = covering.some((s) =>
      criterionGroundedForSkipPromote(c, s.expectedFiles, repoFiles),
    );
    if (!grounded) return c;
    return {
      ...c,
      status: "met" as const,
      rationale: "Worker skip: work already present (disk-grounded)",
    };
  });
}
