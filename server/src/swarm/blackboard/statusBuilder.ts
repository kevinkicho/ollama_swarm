import type { SwarmStatus, AgentState, TranscriptEntry, TranscriptEntrySummary } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract } from "./types.js";
import type { RunSummary } from "./summary.js";
import { boardCounts as boardCountsExtracted, boardSnapshot as boardSnapshotExtracted, type RunnerUtilContext } from "./runnerUtil.js";

export interface StatusContext {
  phase: string;
  round: number;
  active?: RunConfig;
  transcript: TranscriptEntry[];
  lastSummary?: RunSummary;
  contract?: ExitContract;
  cloneStateForStatus?: {
    alreadyPresent: boolean;
    clonePath: string;
    priorCommits: number;
    priorChangedFiles: number;
    priorUntrackedFiles: number;
  };
  runBootedAt?: number;
  recentLatencySamples: Map<string, Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>>;
  cloneContract: (c: ExitContract) => ExitContract;
  agentStates: () => AgentState[];
  getPartialStreams: () => Record<string, { text: string; updatedAt: number }>;
  utilCtx: () => RunnerUtilContext;
}

export function status(ctx: StatusContext): SwarmStatus {
  const board = boardSnapshotExtracted(ctx.utilCtx());
  const counts = boardCountsExtracted(ctx.utilCtx());
  const latency: Record<string, Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>> = {};
  for (const [agentId, samples] of ctx.recentLatencySamples.entries()) {
    latency[agentId] = samples.map((s) => ({ ...s }));
  }
  const runConfig = ctx.active
    ? {
        preset: ctx.active.preset,
        plannerModel: ctx.active.plannerModel ?? ctx.active.model,
        workerModel: ctx.active.workerModel ?? ctx.active.model,
        auditorModel: ctx.active.auditorModel ?? ctx.active.plannerModel ?? ctx.active.model,
        dedicatedAuditor: ctx.active.dedicatedAuditor === true,
        repoUrl: ctx.active.repoUrl,
        clonePath: ctx.active.localPath,
        agentCount: ctx.active.agentCount,
        rounds: ctx.active.rounds,
      }
    : undefined;
  return {
    phase: ctx.phase as import("../../types.js").SwarmPhase,
    round: ctx.round,
    repoUrl: ctx.active?.repoUrl,
    localPath: ctx.active?.localPath,
    model: ctx.active?.model,
    agents: ctx.agentStates(),
    transcript: [...ctx.transcript],
    summary: ctx.lastSummary,
    contract: ctx.contract ? ctx.cloneContract(ctx.contract) : undefined,
    cloneState: ctx.cloneStateForStatus,
    runConfig,
    runStartedAt: ctx.runBootedAt,
    board: { todos: board.todos, findings: board.findings, counts },
    latency,
    streaming: ctx.getPartialStreams(),
  };
}