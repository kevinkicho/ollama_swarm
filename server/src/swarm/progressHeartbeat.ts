/**
 * Run-level durable-progress heartbeat (RR-D).
 * lastProductiveAt advances on commits / durable apply success.
 */

const lastProductiveAtByRun = new Map<string, number>();
let lastRunId: string | null = null;

function key(runId?: string | null): string {
  return (runId ?? lastRunId ?? "").trim() || "_default";
}

export function startProgressHeartbeat(runId?: string | null): void {
  const id = (runId ?? "").trim() || "_default";
  lastRunId = id;
  lastProductiveAtByRun.set(id, Date.now());
}

/** Call when durable progress happens (commit, met flip, tier, etc.). */
export function noteProductiveProgress(runId?: string | null, atMs: number = Date.now()): void {
  const id = key(runId);
  lastRunId = id;
  lastProductiveAtByRun.set(id, atMs);
}

export function getLastProductiveAt(runId?: string | null): number | undefined {
  return lastProductiveAtByRun.get(key(runId));
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
