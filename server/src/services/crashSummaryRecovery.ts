// Best-effort summary synthesis when a run was interrupted (server restart,
// shutdown timeout, hard kill) before the runner's close-out wrote summary.json.

import type { TranscriptEntry } from "../types.js";
import { buildDiscussionSummary, writeRunSummary } from "../swarm/runSummary.js";
import type { PerAgentStat } from "../swarm/blackboard/summary.js";
import { loadRunSummaryForRunId } from "./runSummaryDiscovery.js";

export interface PersistedRunSnapshot {
  runId: string;
  preset: string;
  phase: string;
  startedAt: number;
  lastEventAt?: number;
  transcript?: TranscriptEntry[];
  runConfig?: {
    repoUrl?: string;
    localPath?: string;
    clonePath?: string;
    model?: string;
    agentCount?: number;
    rounds?: number;
    topology?: unknown;
    preset?: string;
  };
}

function inferAgentStats(transcript: TranscriptEntry[]): PerAgentStat[] {
  const byIndex = new Map<number, number>();
  for (const e of transcript) {
    if (e.role !== "agent" || e.agentIndex == null) continue;
    byIndex.set(e.agentIndex, (byIndex.get(e.agentIndex) ?? 0) + 1);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([agentIndex, turnsTaken]) => ({
      agentId: `agent-${agentIndex}`,
      agentIndex,
      turnsTaken,
      tokensIn: null,
      tokensOut: null,
    }));
}

export function buildRecoveredCrashSummary(
  snap: PersistedRunSnapshot,
  clonePath: string,
  runId: string,
) {
  const rc = snap.runConfig ?? {};
  const transcript = snap.transcript ?? [];
  const startedAt = snap.startedAt;
  const endedAt = snap.lastEventAt ?? Date.now();
  const localPath = rc.localPath ?? rc.clonePath ?? clonePath;

  return buildDiscussionSummary({
    config: {
      repoUrl: rc.repoUrl ?? "",
      localPath,
      preset: (rc.preset ?? snap.preset) as string,
      model: rc.model ?? "",
      runId,
    },
    agentCount: rc.agentCount ?? inferAgentStats(transcript).length,
    rounds: rc.rounds ?? 0,
    startedAt,
    endedAt,
    crashMessage: `Run interrupted during "${snap.phase}" (no graceful close-out — e.g. server restart or stop timeout)`,
    stopping: false,
    filesChanged: 0,
    finalGitStatus: "",
    agents: inferAgentStats(transcript),
    transcript,
    topology: rc.topology as import("../swarm/SwarmRunner.js").RunConfig["topology"],
  });
}

/**
 * Write a crash summary from a persisted run-state snapshot when no terminal
 * summary exists. Idempotent — skips if a matching summary is already on disk.
 */
export async function recoverCrashSummaryFromSnapshot(
  snap: PersistedRunSnapshot,
  clonePath: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const existing = loadRunSummaryForRunId(clonePath, runId);
  if (existing?.stopReason) return existing;

  const summary = buildRecoveredCrashSummary(snap, clonePath, runId);
  try {
    await writeRunSummary(clonePath, summary);
    return summary as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}