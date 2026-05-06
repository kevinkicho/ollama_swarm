// Extracted from BlackboardRunner.ts — writeRunSummary and buildPerAgentStats.
// Takes narrow context objects instead of referencing `this.*`.

import path from "node:path";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract, Todo } from "./types.js";
import type { TranscriptEntry, TranscriptEntrySummary, SwarmEvent } from "../../types.js";
import type { PerAgentStat, RunSummary } from "./summary.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { RunStateObserver } from "./RunStateObserver.js";
import { computeLatencyStats } from "./summary.js";
import { buildPerRunSummaryFileName, buildRunFinishedSummary, formatRunFinishedBanner } from "../runSummary.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { buildSummary } from "./summary.js";

export interface PerAgentCounters {
  agentRoster: Array<{ id: string; index: number }>;
  turnsPerAgent: Map<string, number>;
  promptTokensPerAgent: Map<string, number>;
  responseTokensPerAgent: Map<string, number>;
  attemptsPerAgent: Map<string, number>;
  retriesPerAgent: Map<string, number>;
  latenciesPerAgent: Map<string, number[]>;
  commitsPerAgent: Map<string, number>;
  linesAddedPerAgent: Map<string, number>;
  linesRemovedPerAgent: Map<string, number>;
  rejectedAttemptsPerAgent: Map<string, number>;
  jsonRepairsPerAgent: Map<string, number>;
  promptErrorsPerAgent: Map<string, number>;
}

export function buildPerAgentStats(counters: PerAgentCounters): PerAgentStat[] {
  return counters.agentRoster.map((a) => {
    const lats = counters.latenciesPerAgent.get(a.id) ?? [];
    const stats = computeLatencyStats(lats);
    return {
      agentId: a.id,
      agentIndex: a.index,
      turnsTaken: counters.turnsPerAgent.get(a.id) ?? 0,
      tokensIn: counters.promptTokensPerAgent.has(a.id) ? counters.promptTokensPerAgent.get(a.id)! : null,
      tokensOut: counters.responseTokensPerAgent.has(a.id) ? counters.responseTokensPerAgent.get(a.id)! : null,
      totalAttempts: counters.attemptsPerAgent.get(a.id) ?? 0,
      totalRetries: counters.retriesPerAgent.get(a.id) ?? 0,
      successfulAttempts: lats.length,
      meanLatencyMs: stats.mean,
      p50LatencyMs: stats.p50,
      p95LatencyMs: stats.p95,
      commits: counters.commitsPerAgent.get(a.id) ?? 0,
      linesAdded: counters.linesAddedPerAgent.get(a.id) ?? 0,
      linesRemoved: counters.linesRemovedPerAgent.get(a.id) ?? 0,
      rejectedAttempts: counters.rejectedAttemptsPerAgent.get(a.id) ?? 0,
      jsonRepairs: counters.jsonRepairsPerAgent.get(a.id) ?? 0,
      promptErrors: counters.promptErrorsPerAgent.get(a.id) ?? 0,
    };
  });
}

export interface SummaryContext {
  cfg: RunConfig;
  runBootedAt: number;
  runStartedAt: number | undefined;
  tickAccumulatorActiveElapsedMs: number | undefined;
  stopping: boolean;
  terminationReason: string | undefined;
  completionDetail: string | undefined;
  staleEventCount: number;
  auditInvocations: number;
  currentTier: number;
  tiersCompleted: number;
  tierHistory: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
    wallClockMs: number;
    startedAt: number;
    endedAt: number;
  }>;
  contract: ExitContract | undefined;
  transcript: TranscriptEntry[];
  agentStats: PerAgentStat[];
  boardCounts: { committed: number; skipped: number; total: number };
  gitStatus: { porcelain: string; changedFiles: number };
  errorTracker: ClassifiedError[];
  v2State: { phase: string; enteredAt: number; detail?: string; pausedReason?: string };
  v2QueueState: { counts: ReturnType<TodoQueue["counts"]> };
  cloneContract: (c: ExitContract) => ExitContract;
  lastSummarySetter: (s: RunSummary) => void;
  emit: (event: SwarmEvent) => void;
  appendSystem: (msg: string, summary?: TranscriptEntrySummary) => void;
}

export async function writeRunSummary(ctx: SummaryContext): Promise<void> {
  const { cfg } = ctx;
  if (ctx.runBootedAt === undefined) return;

  const summary = buildSummary({
    config: {
      repoUrl: cfg.repoUrl,
      localPath: cfg.localPath,
      preset: cfg.preset,
      model: cfg.model,
      runId: cfg.runId,
    },
    agentCount: cfg.agentCount,
    rounds: cfg.rounds,
    startedAt: ctx.runBootedAt,
    endedAt: Date.now(),
    crashMessage: undefined,
    terminationReason: ctx.terminationReason,
    stopping: ctx.stopping,
    completionDetail: ctx.completionDetail,
    board: {
      committed: ctx.boardCounts.committed,
      skipped: ctx.boardCounts.skipped,
      total: ctx.boardCounts.total,
    },
    staleEvents: ctx.staleEventCount,
    filesChanged: ctx.gitStatus.changedFiles,
    finalGitStatus: ctx.gitStatus.porcelain,
    agents: ctx.agentStats,
    contract: ctx.contract ? ctx.cloneContract(ctx.contract) : undefined,
    maxTierReached: ctx.currentTier > 0 ? ctx.currentTier : undefined,
    tiersCompleted: ctx.currentTier > 0 ? ctx.tiersCompleted : undefined,
    tierHistory: ctx.tierHistory.length > 0 ? ctx.tierHistory.slice() : undefined,
    transcript: ctx.transcript,
    v2State: ctx.v2State,
    v2QueueState: ctx.v2QueueState,
    topology: cfg.topology,
    errors: ctx.errorTracker,
  });

  const json = JSON.stringify(summary, null, 2);
  const perRunPath = path.join(cfg.localPath, buildPerRunSummaryFileName(summary.startedAt));
  const latestPath = path.join(cfg.localPath, "summary.json");
  try {
    await writeFileAtomic(perRunPath, json);
    await writeFileAtomic(latestPath, json);
    ctx.appendSystem(formatRunFinishedBanner(summary), buildRunFinishedSummary(summary));
    ctx.appendSystem(
      `Wrote run summary to ${perRunPath} + ${latestPath} (stopReason=${summary.stopReason}, commits=${summary.commits}, files=${summary.filesChanged}).`,
    );
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    ctx.appendSystem(`Failed to write run summary (${msg})`);
  }
  ctx.lastSummarySetter(summary);
  ctx.emit({ type: "run_summary", summary });
}