/**
 * Run-scoped applyIntegrity counters for council / blackboard / wrap-up.
 *
 * Pure types + mutators live in @ollama-swarm/shared/applyIntegrityReport.
 * This module holds the active counters so applyAndCommit and repair paths
 * can record without threading a counters object through every context.
 *
 * Keyed by runId when available; falls back to last-started run (single
 * active swarm run is the common case).
 */

import {
  createApplyIntegrityCounters,
  recordApplyAttempt,
  recordApplyMiss,
  recordApplySuccess,
  recordRepairFailure,
  recordRepairSuccess,
  snapshotApplyIntegrity,
  type ApplyIntegrityCounters,
  type ApplyIntegrityReport,
} from "@ollama-swarm/shared/applyIntegrityReport";

export type { ApplyIntegrityCounters, ApplyIntegrityReport };
export {
  createApplyIntegrityCounters,
  snapshotApplyIntegrity,
} from "@ollama-swarm/shared/applyIntegrityReport";

const byRunId = new Map<string, ApplyIntegrityCounters>();
let lastRunId: string | undefined;

function resolveKey(runId?: string | null): string {
  const id = runId?.trim();
  if (id) return id;
  return lastRunId ?? "__default__";
}

/** Start (or reset) counters for a run. Call from runner start(). */
export function startApplyIntegrityTracking(runId?: string | null): ApplyIntegrityCounters {
  const key = resolveKey(runId);
  if (runId?.trim()) lastRunId = runId.trim();
  const c = createApplyIntegrityCounters();
  byRunId.set(key, c);
  return c;
}

/** Counters for a run (creates empty set if missing — safe no-op paths). */
export function getApplyIntegrityCounters(runId?: string | null): ApplyIntegrityCounters {
  const key = resolveKey(runId);
  let c = byRunId.get(key);
  if (!c) {
    c = createApplyIntegrityCounters();
    byRunId.set(key, c);
  }
  return c;
}

export function noteApplyAttempt(runId?: string | null): void {
  recordApplyAttempt(getApplyIntegrityCounters(runId));
}

export function noteApplySuccess(runId?: string | null): void {
  recordApplySuccess(getApplyIntegrityCounters(runId));
}

export function noteApplyMiss(kind: string, runId?: string | null): void {
  recordApplyMiss(getApplyIntegrityCounters(runId), kind);
}

export function noteRepairSuccess(runId?: string | null): void {
  recordRepairSuccess(getApplyIntegrityCounters(runId));
}

export function noteRepairFailure(runId?: string | null): void {
  recordRepairFailure(getApplyIntegrityCounters(runId));
}

/** Snapshot for summary assembly; does not clear (reset happens at next start). */
export function snapshotApplyIntegrityForRun(
  runId?: string | null,
): ApplyIntegrityReport | undefined {
  const key = resolveKey(runId);
  return snapshotApplyIntegrity(byRunId.get(key));
}

/** Drop counters after summary (optional; start() always replaces). */
export function clearApplyIntegrityTracking(runId?: string | null): void {
  if (runId?.trim()) {
    byRunId.delete(runId.trim());
    if (lastRunId === runId.trim()) lastRunId = undefined;
    return;
  }
  byRunId.clear();
  lastRunId = undefined;
}
