/**
 * Run-level durable-progress heartbeat (RR-D).
 * lastProductiveAt advances on commits / durable apply success only —
 * not at run start (avoids false "just progressed" at T0).
 */

const lastProductiveAtByRun = new Map<string, number>();
let lastRunId: string | null = null;

function writeKey(runId?: string | null): string | undefined {
  const id = (runId ?? "").trim();
  return id || undefined;
}

function readKey(runId?: string | null): string | undefined {
  const id = (runId ?? "").trim();
  if (id) return id;
  return lastRunId ?? undefined;
}

export function startProgressHeartbeat(runId?: string | null): void {
  const id = (runId ?? "").trim();
  if (id) lastRunId = id;
  // Clear prior residue; do not stamp lastProductiveAt until real progress.
  if (id) lastProductiveAtByRun.delete(id);
}

/** Call when durable progress happens (commit, met flip, tier, etc.). */
export function noteProductiveProgress(runId?: string | null, atMs: number = Date.now()): void {
  const id = writeKey(runId);
  if (!id) return; // fail-closed under multi-run without attribution
  lastRunId = id;
  lastProductiveAtByRun.set(id, atMs);
}

export function getLastProductiveAt(runId?: string | null): number | undefined {
  const id = readKey(runId);
  if (!id) return undefined;
  return lastProductiveAtByRun.get(id);
}

export function getProgressQuietMs(
  runId?: string | null,
  now: number = Date.now(),
): number | undefined {
  const t = getLastProductiveAt(runId);
  if (t == null) return undefined;
  return Math.max(0, now - t);
}

export interface ProgressHeartbeatStatus {
  lastProductiveAt: number;
  progressQuietMs: number;
}

export function snapshotProgressHeartbeat(
  runId?: string | null,
  now: number = Date.now(),
): ProgressHeartbeatStatus | undefined {
  const lastProductiveAt = getLastProductiveAt(runId);
  if (lastProductiveAt == null) return undefined;
  return {
    lastProductiveAt,
    progressQuietMs: Math.max(0, now - lastProductiveAt),
  };
}

export function clearProgressHeartbeat(runId?: string | null): void {
  if (runId?.trim()) {
    const id = runId.trim();
    lastProductiveAtByRun.delete(id);
    if (lastRunId === id) lastRunId = null;
    return;
  }
  lastProductiveAtByRun.clear();
  lastRunId = null;
}
