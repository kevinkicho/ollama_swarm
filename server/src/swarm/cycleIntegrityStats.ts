/**
 * Run-scoped cycleIntegrity counters (RR-D).
 */

import {
  type CycleFailBucket,
  type CycleIntegrityCounters,
  type CycleIntegrityReport,
  classifyCycleFailReason,
  createCycleIntegrityCounters,
  noteCycleFail,
  noteCycleSuccess,
  noteEmptyExecutionCycle,
  noteNonEmptyExecutionCycle,
  snapshotCycleIntegrity,
} from "@ollama-swarm/shared/cycleIntegrityReport";

export type {
  CycleFailBucket,
  CycleIntegrityCounters,
  CycleIntegrityReport,
} from "@ollama-swarm/shared/cycleIntegrityReport";

export {
  classifyCycleFailReason,
  createCycleIntegrityCounters,
  snapshotCycleIntegrity,
} from "@ollama-swarm/shared/cycleIntegrityReport";

const byRun = new Map<string, CycleIntegrityCounters>();
let lastRunId: string | null = null;

function resolve(runId?: string | null): CycleIntegrityCounters {
  const id = (runId ?? lastRunId ?? "").trim() || "_default";
  let c = byRun.get(id);
  if (!c) {
    c = createCycleIntegrityCounters();
    byRun.set(id, c);
  }
  return c;
}

export function startCycleIntegrityTracking(runId?: string | null): CycleIntegrityCounters {
  const id = (runId ?? "").trim() || "_default";
  lastRunId = id;
  const c = createCycleIntegrityCounters();
  byRun.set(id, c);
  return c;
}

export function recordCycleFail(
  reasonOrBucket: string | CycleFailBucket,
  runId?: string | null,
): void {
  const c = resolve(runId);
  const bucket =
    typeof reasonOrBucket === "string" &&
    ![
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
      "other",
    ].includes(reasonOrBucket)
      ? classifyCycleFailReason(reasonOrBucket)
      : (reasonOrBucket as CycleFailBucket);
  noteCycleFail(c, bucket);
}

export function recordCycleTodoSuccess(runId?: string | null): void {
  noteCycleSuccess(resolve(runId));
}

export function recordEmptyExecutionCycle(runId?: string | null): void {
  noteEmptyExecutionCycle(resolve(runId));
}

export function recordNonEmptyExecutionCycle(runId?: string | null): void {
  noteNonEmptyExecutionCycle(resolve(runId));
}

export function snapshotCycleIntegrityForRun(
  runId?: string | null,
): CycleIntegrityReport | undefined {
  const id = (runId ?? lastRunId ?? "").trim() || "_default";
  return snapshotCycleIntegrity(byRun.get(id));
}

/** Drop counters after summary (or on next start for same process). */
export function clearCycleIntegrityTracking(runId?: string | null): void {
  if (runId?.trim()) {
    const id = runId.trim();
    byRun.delete(id);
    if (lastRunId === id) lastRunId = null;
    return;
  }
  byRun.clear();
  lastRunId = null;
}
