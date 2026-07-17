/**
 * Cycle fail taxonomy for council/blackboard runs (RR-D).
 * Pure helpers — runners own mutation / persistence.
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
  | "other";

export interface CycleIntegrityCounters {
  cyclesCompleted: number;
  emptyExecutionCycles: number;
  failByBucket: Partial<Record<CycleFailBucket, number>>;
  todosFailed: number;
  todosSucceeded: number;
  lastEmptyStreak: number;
  maxEmptyStreak: number;
}

export interface CycleIntegrityReport {
  cyclesCompleted: number;
  emptyExecutionCycles: number;
  failByBucket: Record<string, number>;
  todosFailed: number;
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
    todosSucceeded: 0,
    lastEmptyStreak: 0,
    maxEmptyStreak: 0,
  };
}

export function noteCycleFail(
  c: CycleIntegrityCounters,
  bucket: CycleFailBucket,
): void {
  c.failByBucket[bucket] = (c.failByBucket[bucket] ?? 0) + 1;
  c.todosFailed += 1;
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

/** Map free-text reasons to buckets (fallback when structured code absent). */
export function classifyCycleFailReason(reason: string): CycleFailBucket {
  const r = reason.toLowerCase();
  // Order matters: tool-loop / transport before generic "search" apply patterns
  // (e.g. "tool loop stuck: research" must not become apply_miss).
  if (/tool.?loop|tool loop stuck|research fail streak/.test(r)) return "tool_loop";
  if (/quota|429|network|econn|provider|auth/.test(r)) return "transport";
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
    c.todosSucceeded > 0 ||
    Object.keys(c.failByBucket).length > 0;
  if (!hasActivity) return undefined;
  return {
    cyclesCompleted: c.cyclesCompleted,
    emptyExecutionCycles: c.emptyExecutionCycles,
    failByBucket: { ...c.failByBucket } as Record<string, number>,
    todosFailed: c.todosFailed,
    todosSucceeded: c.todosSucceeded,
    lastEmptyStreak: c.lastEmptyStreak,
    maxEmptyStreak: c.maxEmptyStreak,
  };
}
