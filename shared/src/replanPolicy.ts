/** Stale-reason classification for replanner tool/emit policy. */

export type StaleReasonClass =
  | "worker-timeout"
  | "worker-tool-cap"
  | "cas-drift"
  | "hunk-fail"
  | "auditor"
  | "prompt-fail"
  | "unknown";

export interface ReplanPolicy {
  staleClass: StaleReasonClass;
  /** First attempt uses emit-only profile when true. */
  emitFirst: boolean;
  /** Allow a bounded explore turn after emit failures. */
  allowExplore: boolean;
  /** Tool-loop cap for explore turns (0 = emit-only). */
  maxToolTurns: number;
}

const WORKER_TIMEOUT_RE = /wall[- ]?clock exceeded|prompt wall-clock/i;
const WORKER_TOOL_CAP_RE = /tool loop exceeded|tool cap|tool-turn/i;
const CAS_RE = /cas mismatch/i;
const HUNK_RE = /hunk apply failed|hunk.*reject/i;
/** No-op / empty apply — same family as hunk-fail for replan policy. */
const NOOP_RE =
  /no file changes|no-op elided|wrote zero files|zero files \(no-op\)|hunk-empty|empty hunks/i;
const AUDITOR_RE = /auditor:|hallucinated|auditor-confirmed/i;
const PROMPT_FAIL_RE = /prompt failed|transport:/i;

export function classifyStaleReason(reason: string | undefined): StaleReasonClass {
  const r = (reason ?? "").trim();
  if (!r) return "unknown";
  if (WORKER_TIMEOUT_RE.test(r)) return "worker-timeout";
  if (WORKER_TOOL_CAP_RE.test(r)) return "worker-tool-cap";
  if (CAS_RE.test(r)) return "cas-drift";
  if (NOOP_RE.test(r) || HUNK_RE.test(r)) return "hunk-fail";
  if (AUDITOR_RE.test(r)) return "auditor";
  if (PROMPT_FAIL_RE.test(r)) return "prompt-fail";
  return "unknown";
}

export function resolveReplanPolicy(
  staleReason: string | undefined,
  opts?: { batchBreaker?: boolean; hasExplorationCache?: boolean },
): ReplanPolicy {
  const staleClass = classifyStaleReason(staleReason);
  const batch = opts?.batchBreaker === true;
  const cached = opts?.hasExplorationCache === true;

  switch (staleClass) {
    case "worker-timeout":
    case "worker-tool-cap":
      return {
        staleClass,
        emitFirst: true,
        allowExplore: !batch && !cached,
        maxToolTurns: batch || cached ? 0 : 8,
      };
    case "cas-drift":
    case "hunk-fail":
      return {
        staleClass,
        emitFirst: false,
        allowExplore: true,
        maxToolTurns: 4,
      };
    case "auditor":
      return {
        staleClass,
        emitFirst: true,
        allowExplore: false,
        maxToolTurns: 0,
      };
    case "prompt-fail":
      return {
        staleClass,
        emitFirst: true,
        allowExplore: true,
        maxToolTurns: 6,
      };
    default:
      return {
        staleClass,
        emitFirst: cached || batch,
        allowExplore: !cached,
        maxToolTurns: cached || batch ? 0 : 8,
      };
  }
}

/** Correlated stale failures — pause broad re-explore. */
export const BATCH_REPLAN_BREAKER_THRESHOLD = 3;

export function countStaleByReasonClass(
  todos: ReadonlyArray<{ status: string; staleReason?: string }>,
): Map<StaleReasonClass, number> {
  const counts = new Map<StaleReasonClass, number>();
  for (const t of todos) {
    if (t.status !== "stale") continue;
    const cls = classifyStaleReason(t.staleReason);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return counts;
}

export function shouldTriggerBatchReplanBreaker(
  todos: ReadonlyArray<{ status: string; staleReason?: string }>,
): boolean {
  const counts = countStaleByReasonClass(todos);
  for (const cls of ["worker-timeout", "worker-tool-cap"] as const) {
    if ((counts.get(cls) ?? 0) >= BATCH_REPLAN_BREAKER_THRESHOLD) return true;
  }
  return false;
}