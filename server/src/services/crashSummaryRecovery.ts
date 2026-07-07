// Best-effort summary synthesis when a run was interrupted (server restart,
// shutdown timeout, hard kill) before the runner's close-out wrote summary.json.

import type { TranscriptEntry } from "../types.js";
import { buildDiscussionSummary, writeRunSummary } from "../swarm/runSummary.js";
import type { PerAgentStat } from "../swarm/blackboard/summary.js";
import { loadRunSummaryForRunId } from "./runSummaryDiscovery.js";
import type { RepoService } from "./RepoService.js";

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

export interface CrashSummaryOverrides {
  phase?: string;
  filesChanged?: number;
  finalGitStatus?: string;
}

/** Prefer transcript signals over the persisted snapshot phase (often stale). */
export function inferCrashPhaseFromTranscript(transcript: TranscriptEntry[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i]!;
    const summary = e.summary;
    if (summary?.kind === "council_stage" && summary.stage === "execution") return "executing";
    if (summary?.kind === "council_cycle" && summary.executionOnly) return "executing";
    if (e.text?.includes("[execution] Starting")) return "executing";
    if (summary?.kind === "council_stage" && summary.stage === "synthesis") return "discussing";
    if (summary?.kind === "council_stage" && summary.stage === "discussion") return "discussing";
  }
  return undefined;
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
  overrides: CrashSummaryOverrides = {},
) {
  const rc = snap.runConfig ?? {};
  const transcript = snap.transcript ?? [];
  const startedAt = snap.startedAt;
  const endedAt = snap.lastEventAt ?? Date.now();
  const localPath = rc.localPath ?? rc.clonePath ?? clonePath;
  const phase =
    overrides.phase
    ?? inferCrashPhaseFromTranscript(transcript)
    ?? snap.phase;

  const summary = buildDiscussionSummary({
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
    crashMessage: `Run interrupted during "${phase}" (no graceful close-out — e.g. server restart or stop timeout)`,
    stopping: false,
    filesChanged: overrides.filesChanged ?? 0,
    finalGitStatus: overrides.finalGitStatus ?? "",
    agents: inferAgentStats(transcript),
    transcript,
    topology: rc.topology as import("../swarm/SwarmRunner.js").RunConfig["topology"],
  });

  // buildDiscussionSummary zeroes filesChanged for discussion presets; crash
  // recovery during council execution should preserve git stats when known.
  if (overrides.filesChanged != null) summary.filesChanged = overrides.filesChanged;
  if (overrides.finalGitStatus != null) summary.finalGitStatus = overrides.finalGitStatus;

  return summary;
}

async function resolveGitStatus(
  clonePath: string,
  repos?: Pick<RepoService, "gitStatus">,
): Promise<{ filesChanged: number; finalGitStatus: string }> {
  if (!repos) return { filesChanged: 0, finalGitStatus: "" };
  try {
    const gs = await repos.gitStatus(clonePath);
    return { filesChanged: gs.changedFiles, finalGitStatus: gs.porcelain };
  } catch {
    return { filesChanged: 0, finalGitStatus: "" };
  }
}

/**
 * Write a crash summary from a persisted run-state snapshot when no terminal
 * summary exists. Idempotent — skips if a matching summary is already on disk.
 */
export async function recoverCrashSummaryFromSnapshot(
  snap: PersistedRunSnapshot,
  clonePath: string,
  runId: string,
  repos?: Pick<RepoService, "gitStatus">,
): Promise<Record<string, unknown> | null> {
  const existing = loadRunSummaryForRunId(clonePath, runId);
  if (existing?.stopReason) return existing;

  const git = await resolveGitStatus(clonePath, repos);
  const phase = inferCrashPhaseFromTranscript(snap.transcript ?? []) ?? snap.phase;
  const summary = buildRecoveredCrashSummary(snap, clonePath, runId, {
    phase,
    filesChanged: git.filesChanged,
    finalGitStatus: git.finalGitStatus,
  });
  try {
    await writeRunSummary(clonePath, summary);
    return summary as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}