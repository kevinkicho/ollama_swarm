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

/**
 * Hot shared files that thrash under multi-writer apply (run 961a885f cycle 4):
 * panelRegistry / marketPanels / DataProvider — merge + serialize writers.
 */
export const HOT_SHARED_FILE_BASENAMES = new Set([
  "panelregistry.js",
  "panelregistry.jsx",
  "panelregistry.ts",
  "panelregistry.tsx",
  "marketpanels.js",
  "marketpanels.jsx",
  "marketpanels.ts",
  "marketpanels.tsx",
  "dataprovider.jsx",
  "dataprovider.js",
  "dataprovider.ts",
  "dataprovider.tsx",
  "datasources.js",
  "datasources.ts",
]);

function fileBasenameLower(p: string): string {
  const n = p.replace(/\\/g, "/");
  const base = n.split("/").pop() ?? n;
  return base.toLowerCase();
}

/** True when paths share a hot registry/provider basename (even if dirs differ). */
export function hotSharedFilesOverlap(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const hotA = new Set(
    a.map(fileBasenameLower).filter((bname) => HOT_SHARED_FILE_BASENAMES.has(bname)),
  );
  if (hotA.size === 0) return false;
  for (const p of b) {
    const bname = fileBasenameLower(p);
    if (hotA.has(bname)) return true;
  }
  return false;
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
        const pathOverlap = expectedFilesOverlap(a.expectedFiles, b.expectedFiles);
        const hotOverlap = hotSharedFilesOverlap(a.expectedFiles, b.expectedFiles);
        if (!pathOverlap && !hotOverlap) continue;

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
      `[execution-plan] Merged ${mergeCount} overlapping todo(s) — one writer per shared expectedFiles/hot registries.`,
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

/**
 * How many consecutive terminal fails on a basename before we deprioritize
 * (not ban) that file in dequeue. Soft penalty — other work still preferred.
 */
export const HOTSPOT_FAIL_STREAK_SOFT = 2;
/** At this streak, only schedule if no non-hotspot pending work remains. */
export const HOTSPOT_FAIL_STREAK_HARD = 4;

/** Dequeue score: higher = sooner. Returns NEGATIVE_INFINITY when deferred. */
export function scoreCouncilTodoForDequeue(
  todo: { kind?: "hunks" | "build"; description: string; expectedFiles: readonly string[] },
  inProgress: readonly { expectedFiles: readonly string[] }[],
  hasPendingOrActiveNonBuild: boolean,
  opts?: {
    /** basename → fail streak this cycle (from settlement book) */
    fileFailStreak?: ReadonlyMap<string, number>;
    /** True when some other pending todo is not on a hard-hotspot file */
    hasNonHotspotPending?: boolean;
  },
): number {
  if (todo.kind === "build" && hasPendingOrActiveNonBuild) {
    return Number.NEGATIVE_INFINITY;
  }

  for (const active of inProgress) {
    if (todo.expectedFiles.length === 0 || active.expectedFiles.length === 0) {
      continue;
    }
    // Exact path overlap OR hot shared registries (panelRegistry, marketPanels, …)
    if (
      expectedFilesOverlap(todo.expectedFiles, active.expectedFiles)
      || hotSharedFilesOverlap(todo.expectedFiles, active.expectedFiles)
    ) {
      return Number.NEGATIVE_INFINITY;
    }
  }

  const tier = councilExecutionTier(todo.description, todo.expectedFiles);
  let score = 100 - TIER_RANK[tier] * 10;

  // Hotspot soft/hard deprioritize — does not ban agents; prefers fresher work.
  const streakMap = opts?.fileFailStreak;
  if (streakMap && todo.expectedFiles.length > 0) {
    let maxStreak = 0;
    for (const p of todo.expectedFiles) {
      const base = fileBasenameLower(p);
      maxStreak = Math.max(maxStreak, streakMap.get(base) ?? 0);
    }
    if (maxStreak >= HOTSPOT_FAIL_STREAK_HARD && opts?.hasNonHotspotPending) {
      return Number.NEGATIVE_INFINITY;
    }
    if (maxStreak >= HOTSPOT_FAIL_STREAK_SOFT) {
      score -= 15 * Math.min(maxStreak, 6);
    }
  }

  return score;
}