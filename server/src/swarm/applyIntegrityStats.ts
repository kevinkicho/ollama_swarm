/**
 * Run-scoped applyIntegrity counters for council / blackboard / wrap-up.
 *
 * Pure types + mutators live in @ollama-swarm/shared/applyIntegrityReport.
 * This module holds the active counters so applyAndCommit and repair paths
 * can record without threading a counters object through every context.
 *
 * Keyed by runId. Mutations without a resolvable runId are no-ops
 * (fail-closed under multi-run concurrency — no silent __default__ writes).
 * Reads may still fall back to last-started run for single-tenant status.
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

/** Explicit runId only — never invent a shared bucket for writers. */
function resolveWriteKey(runId?: string | null): string | undefined {
  const id = runId?.trim();
  if (id) return id;
  return undefined;
}

/** Read path: prefer explicit runId, else last-started (single-run UI). */
function resolveReadKey(runId?: string | null): string | undefined {
  const id = runId?.trim();
  if (id) return id;
  return lastRunId;
}

/** Start (or reset) counters for a run. Call from runner start(). */
export function startApplyIntegrityTracking(runId?: string | null): ApplyIntegrityCounters {
  const key = resolveWriteKey(runId) ?? lastRunId ?? "__unscoped__";
  if (runId?.trim()) lastRunId = runId.trim();
  const c = createApplyIntegrityCounters();
  byRunId.set(key, c);
  return c;
}

/** Counters for a run (creates empty set if missing — safe no-op paths). */
export function getApplyIntegrityCounters(runId?: string | null): ApplyIntegrityCounters {
  const key = resolveReadKey(runId);
  if (!key) {
    return createApplyIntegrityCounters();
  }
  let c = byRunId.get(key);
  if (!c) {
    c = createApplyIntegrityCounters();
    byRunId.set(key, c);
  }
  return c;
}

export function noteApplyAttempt(runId?: string | null): void {
  const key = resolveWriteKey(runId);
  if (!key) return;
  recordApplyAttempt(getApplyIntegrityCounters(key));
}

export function noteApplySuccess(runId?: string | null): void {
  const key = resolveWriteKey(runId);
  if (!key) return;
  recordApplySuccess(getApplyIntegrityCounters(key));
}

export function noteApplyMiss(kind: string, runId?: string | null): void {
  const key = resolveWriteKey(runId);
  if (!key) return;
  recordApplyMiss(getApplyIntegrityCounters(key), kind);
}

export function noteRepairSuccess(runId?: string | null): void {
  const key = resolveWriteKey(runId);
  if (!key) return;
  recordRepairSuccess(getApplyIntegrityCounters(key));
}

export function noteRepairFailure(runId?: string | null): void {
  const key = resolveWriteKey(runId);
  if (!key) return;
  recordRepairFailure(getApplyIntegrityCounters(key));
}

/** Snapshot for summary assembly; does not clear (reset happens at next start). */
export function snapshotApplyIntegrityForRun(
  runId?: string | null,
): ApplyIntegrityReport | undefined {
  const key = resolveReadKey(runId);
  if (!key) return undefined;
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
