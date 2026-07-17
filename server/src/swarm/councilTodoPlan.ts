import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import { expectedFilesOverlap } from "./blackboard/hypothesisGrouping.js";
import { buildCouncilTodoPost, classifyCouncilTodo } from "./councilTodoClassify.js";

/**
 * Hard cap on todos enqueued in a single prepare/post batch.
 * Run 2964afe8: tier-4 standup flooded 17 todos (13 mislabeled build) → thrash.
 * Blackboard planner already caps at 5; council was unbounded.
 */
export const MAX_COUNCIL_TODOS_PER_BATCH = 10;

export interface CouncilTodoDraft {
  description: string;
  expectedFiles: readonly string[];
  createdBy: string;
  criterionId?: string;
  criteriaIds?: readonly string[];
}

export type CouncilExecutionTier = "cleanup" | "impl" | "test" | "docs" | "build";

const TIER_RANK: Record<CouncilExecutionTier, number> = {
  cleanup: 0,
  impl: 1,
  test: 2,
  docs: 3,
  build: 4,
};

const TEST_PATH_RE = /(?:^|\/)(tests?|__tests__|spec)\/|(?:^|\/)test_[^/]+\.py$|\.test\.|\.spec\./i;
const DOCS_PATH_RE = /(?:\.md$|^docs\/)/i;

/** Classify execution tier for ordering and dequeue priority. */
export function councilExecutionTier(
  description: string,
  expectedFiles: readonly string[],
): CouncilExecutionTier {
  const classified = classifyCouncilTodo(description, expectedFiles);
  if (classified.kind === "build") return "build";

  const lower = description.toLowerCase();
  if (/\bcontradiction\b/.test(lower) || /\b(consolidat|dedup|merge|cleanup|reconcile)\b/.test(lower)) {
    return "cleanup";
  }

  const paths = expectedFiles.length > 0 ? expectedFiles : [description];
  if (paths.some((p) => TEST_PATH_RE.test(p)) || /\b(unit test|pytest|test suite)\b/i.test(description)) {
    return "test";
  }
  if (paths.some((p) => DOCS_PATH_RE.test(p)) || /\b(documentation|readme|strategy doc)\b/i.test(lower)) {
    return "docs";
  }
  return "impl";
}

/** Merge todos that share any expectedFiles path (transitive via iterative merge). */
export function mergeOverlappingCouncilTodos(
  todos: readonly CouncilTodoDraft[],
): { merged: CouncilTodoDraft[]; mergeCount: number } {
  let working = todos.map((t) => ({
    ...t,
    expectedFiles: [...t.expectedFiles],
  }));
  let mergeCount = 0;

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < working.length; i++) {
      for (let j = i + 1; j < working.length; j++) {
        const a = working[i]!;
        const b = working[j]!;
        if (a.expectedFiles.length === 0 || b.expectedFiles.length === 0) continue;
        if (!expectedFilesOverlap(a.expectedFiles, b.expectedFiles)) continue;

        const files = [...new Set([...a.expectedFiles, ...b.expectedFiles])];
        working[i] = {
          ...a,
          description: `${a.description}\n\nAlso (${b.createdBy}): ${b.description}`,
          expectedFiles: files,
        };
        working.splice(j, 1);
        mergeCount++;
        changed = true;
        break outer;
      }
    }
  }

  return { merged: working, mergeCount };
}

/** Sort by execution tier so hunks run before tests/docs and build commands run last. */
export function sortCouncilTodosByTier(todos: readonly CouncilTodoDraft[]): CouncilTodoDraft[] {
  return [...todos].sort((a, b) => {
    const ta = councilExecutionTier(a.description, a.expectedFiles);
    const tb = councilExecutionTier(b.description, b.expectedFiles);
    return TIER_RANK[ta] - TIER_RANK[tb];
  });
}

/** Merge overlaps, sort tiers, emit planning transcript lines. */
export function prepareCouncilTodoBatch(
  todos: readonly CouncilTodoDraft[],
  appendSystem?: (msg: string) => void,
): CouncilTodoDraft[] {
  if (todos.length === 0) return [];

  const { merged, mergeCount } = mergeOverlappingCouncilTodos(todos);
  const sorted = sortCouncilTodosByTier(merged);

  if (mergeCount > 0) {
    appendSystem?.(
      `[execution-plan] Merged ${mergeCount} overlapping todo(s) — one writer per shared expectedFiles.`,
    );
  }

  const tierSummary = sorted
    .map((t) => councilExecutionTier(t.description, t.expectedFiles))
    .reduce(
      (acc, tier) => {
        acc[tier] = (acc[tier] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  const parts = Object.entries(tierSummary)
    .sort(([a], [b]) => TIER_RANK[a as CouncilExecutionTier] - TIER_RANK[b as CouncilExecutionTier])
    .map(([tier, n]) => `${tier}:${n}`);
  appendSystem?.(`[execution-plan] Ordered ${sorted.length} todo(s) — ${parts.join(", ")} (build last).`);

  if (sorted.length > MAX_COUNCIL_TODOS_PER_BATCH) {
    appendSystem?.(
      `[execution-plan] Capping ${sorted.length} → ${MAX_COUNCIL_TODOS_PER_BATCH} todos this batch ` +
        `(ambition flood guard; remainder deferred to later cycles).`,
    );
    return sorted.slice(0, MAX_COUNCIL_TODOS_PER_BATCH);
  }

  return sorted;
}

/** Prepare + post a batch in tier order (FIFO-friendly for council workers). */
export function postCouncilTodoBatch(
  post: (input: PostTodoInput) => void,
  todos: readonly CouncilTodoDraft[],
  appendSystem?: (msg: string) => void,
): number {
  const prepared = prepareCouncilTodoBatch(todos, appendSystem);
  for (const t of prepared) {
    post(
      buildCouncilTodoPost({
        description: t.description,
        expectedFiles: t.expectedFiles,
        createdBy: t.createdBy,
        ...(t.criterionId ? { criterionId: t.criterionId } : {}),
        ...(t.criteriaIds ? { criteriaIds: t.criteriaIds } : {}),
      }),
    );
  }
  return prepared.length;
}

/** Dequeue score: higher = sooner. Returns NEGATIVE_INFINITY when deferred. */
export function scoreCouncilTodoForDequeue(
  todo: { kind?: "hunks" | "build"; description: string; expectedFiles: readonly string[] },
  inProgress: readonly { expectedFiles: readonly string[] }[],
  hasPendingOrActiveNonBuild: boolean,
): number {
  if (todo.kind === "build" && hasPendingOrActiveNonBuild) {
    return Number.NEGATIVE_INFINITY;
  }

  for (const active of inProgress) {
    if (
      todo.expectedFiles.length > 0 &&
      active.expectedFiles.length > 0 &&
      expectedFilesOverlap(todo.expectedFiles, active.expectedFiles)
    ) {
      return Number.NEGATIVE_INFINITY;
    }
  }

  const tier = councilExecutionTier(todo.description, todo.expectedFiles);
  return 100 - TIER_RANK[tier] * 10;
}