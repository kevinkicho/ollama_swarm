/**
 * Cycle fail taxonomy for council/blackboard runs (RR-D).
 * Pure helpers — runners own mutation / persistence.
 *
 * Run 2964afe8: attempt-level fail counters understated routing failures;
 * `todosFailed` stays attempt-level; `todosFailedUnique` counts distinct todos;
 * `build_misroute` covers bare vitest-on-create-tests style failures.
 */

export type CycleFailBucket =
  | "apply_miss"
  | "json_parse"
  | "no_hunks"
  | "tool_loop"
  | "reaper"
  | "noop"
  | "permanent_skip"
  | "schema"
  | "transport"
  | "empty_plan"
  | "build_misroute"
  | "other";

export interface CycleIntegrityCounters {
  cyclesCompleted: number;
  emptyExecutionCycles: number;
  failByBucket: Partial<Record<CycleFailBucket, number>>;
  /** Attempt-level fail events (each agent attempt that failed). */
  todosFailed: number;
  /** Distinct todo ids that failed at least once this run. */
  todosFailedUnique: number;
  todosSucceeded: number;
  lastEmptyStreak: number;
  maxEmptyStreak: number;
  /** Internal: ids already counted toward todosFailedUnique. */
  _failedTodoIds?: Set<string>;
}

export interface CycleIntegrityReport {
  cyclesCompleted: number;
  emptyExecutionCycles: number;
  failByBucket: Record<string, number>;
  /** Attempt-level fail events. */
  todosFailed: number;
  /** Distinct todos that failed at least once. */
  todosFailedUnique: number;
  todosSucceeded: number;
  lastEmptyStreak: number;
  maxEmptyStreak: number;
}

export function createCycleIntegrityCounters(): CycleIntegrityCounters {
  return {
    cyclesCompleted: 0,
    emptyExecutionCycles: 0,
    failByBucket: {},
    todosFailed: 0,
    todosFailedUnique: 0,
    todosSucceeded: 0,
    lastEmptyStreak: 0,
    maxEmptyStreak: 0,
    _failedTodoIds: new Set(),
  };
}

export function noteCycleFail(
  c: CycleIntegrityCounters,
  bucket: CycleFailBucket,
  todoId?: string,
): void {
  c.failByBucket[bucket] = (c.failByBucket[bucket] ?? 0) + 1;
  c.todosFailed += 1;
  if (todoId) {
    if (!c._failedTodoIds) c._failedTodoIds = new Set();
    if (!c._failedTodoIds.has(todoId)) {
      c._failedTodoIds.add(todoId);
      c.todosFailedUnique += 1;
    }
  }
}

export function noteCycleSuccess(c: CycleIntegrityCounters): void {
  c.todosSucceeded += 1;
}

export function noteEmptyExecutionCycle(c: CycleIntegrityCounters): void {
  c.emptyExecutionCycles += 1;
  c.lastEmptyStreak += 1;
  if (c.lastEmptyStreak > c.maxEmptyStreak) {
    c.maxEmptyStreak = c.lastEmptyStreak;
  }
  c.failByBucket.empty_plan = (c.failByBucket.empty_plan ?? 0) + 1;
}

export function noteNonEmptyExecutionCycle(c: CycleIntegrityCounters): void {
  c.cyclesCompleted += 1;
  c.lastEmptyStreak = 0;
}

const KNOWN_BUCKETS: readonly CycleFailBucket[] = [
  "apply_miss",
  "json_parse",
  "no_hunks",
  "tool_loop",
  "reaper",
  "noop",
  "permanent_skip",
  "schema",
  "transport",
  "empty_plan",
  "build_misroute",
  "other",
];

export function isCycleFailBucket(s: string): s is CycleFailBucket {
  return (KNOWN_BUCKETS as readonly string[]).includes(s);
}

/** Map free-text reasons to buckets (fallback when structured code absent). */
export function classifyCycleFailReason(reason: string): CycleFailBucket {
  const r = reason.toLowerCase();
  // Order matters: tool-loop / transport before generic "search" apply patterns
  // (e.g. "tool loop stuck: research" must not become apply_miss).
  if (/tool.?loop|tool loop stuck|research fail streak/.test(r)) return "tool_loop";
  if (/quota|429|network|econn|provider|auth/.test(r) && !/format\/provider|pure\s*<think>/.test(r)) {
    return "transport";
  }
  // Build misroute before generic "no file changes" → noop
  if (
    /build_misroute|build_precondition|build command produced no file changes|demot(?:e|ing) build|bare (?:vitest|jest|mocha|pytest)/.test(
      r,
    )
  ) {
    return "build_misroute";
  }
  // Pure-think / wrong format (run 2964afe8 / eee6718f) — not transport
  if (
    /format\/provider|pure\s*<think>|think-only|json format sniff|no json object found after stripping/.test(
      r,
    )
  ) {
    return "json_parse";
  }
  if (/json|parse|format|envelope|unexpected token/.test(r)) return "json_parse";
  if (/no hunks|empty hunks|hunk-empty|0 hunk/.test(r)) return "no_hunks";
  if (/reaper|ttl|timed out|timeout/.test(r)) return "reaper";
  if (/no-op|noop|zero files|wrote zero/.test(r)) return "noop";
  if (/permanent|wont-do|won't do|already done/.test(r)) return "permanent_skip";
  if (/schema|validation|create on existing|not in expectedfiles|hunks: required/i.test(r)) {
    return "schema";
  }
  if (/empty plan|0 proposal|no todo/.test(r)) return "empty_plan";
  if (
    /apply-miss|hunk-fail|not unique|matches \d+ times|endExclusive|refusing silent full overwrite/.test(
      r,
    ) ||
    (/\b(search|start|end)\b/.test(r) && /not found|not[_ ]unique/.test(r))
  ) {
    return "apply_miss";
  }
  return "other";
}

export function snapshotCycleIntegrity(
  c: CycleIntegrityCounters | undefined | null,
): CycleIntegrityReport | undefined {
  if (!c) return undefined;
  const hasActivity =
    c.cyclesCompleted > 0 ||
    c.emptyExecutionCycles > 0 ||
    c.todosFailed > 0 ||
    c.todosFailedUnique > 0 ||
    c.todosSucceeded > 0 ||
    Object.keys(c.failByBucket).length > 0;
  if (!hasActivity) return undefined;
  return {
    cyclesCompleted: c.cyclesCompleted,
    emptyExecutionCycles: c.emptyExecutionCycles,
    failByBucket: { ...c.failByBucket } as Record<string, number>,
    todosFailed: c.todosFailed,
    todosFailedUnique: c.todosFailedUnique,
    todosSucceeded: c.todosSucceeded,
    lastEmptyStreak: c.lastEmptyStreak,
    maxEmptyStreak: c.maxEmptyStreak,
  };
}
