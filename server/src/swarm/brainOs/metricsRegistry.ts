/**
 * Run-scoped Brain OS metrics (same pattern as applyIntegrityStats).
 * Dispatchers merge their ledger snapshots here for summary.json.
 */

import {
  emptyBrainOsMetrics,
  type BrainOsRunMetrics,
} from "@ollama-swarm/shared/brainOs";

const byRunId = new Map<string, BrainOsRunMetrics>();
let lastRunId: string | undefined;

function writeKey(runId?: string | null): string | undefined {
  const id = runId?.trim();
  return id || undefined;
}

function readKey(runId?: string | null): string | undefined {
  const id = runId?.trim();
  if (id) return id;
  return lastRunId;
}

/** Reset metrics for a run at start. */
export function startBrainOsMetrics(runId?: string | null): void {
  const key = writeKey(runId) ?? lastRunId ?? "__unscoped__";
  if (runId?.trim()) lastRunId = runId.trim();
  byRunId.set(key, emptyBrainOsMetrics());
}

/** Merge a dispatcher ledger snapshot into the run totals. */
export function mergeBrainOsMetrics(
  runId: string | null | undefined,
  snap: BrainOsRunMetrics,
): void {
  const key = writeKey(runId);
  if (!key) return;
  let cur = byRunId.get(key);
  if (!cur) {
    cur = emptyBrainOsMetrics();
    byRunId.set(key, cur);
  }
  cur.dispatches += snap.dispatches;
  cur.resolved += snap.resolved;
  cur.partial += snap.partial;
  cur.blocked += snap.blocked;
  cur.needsHuman += snap.needsHuman;
  cur.helpersSpawned += snap.helpersSpawned;
  cur.childDispatches += snap.childDispatches;
  cur.tokensIn += snap.tokensIn;
  cur.tokensOut += snap.tokensOut;
  cur.wallMs += snap.wallMs;
  cur.effectsApplied += snap.effectsApplied;
  cur.effectsRejected += snap.effectsRejected;
}

/** Snapshot for summary.json (undefined when never used). */
export function snapshotBrainOsMetrics(
  runId?: string | null,
): BrainOsRunMetrics | undefined {
  const key = readKey(runId);
  if (!key) return undefined;
  const m = byRunId.get(key);
  if (!m || m.dispatches === 0 && m.helpersSpawned === 0) return undefined;
  return { ...m };
}
