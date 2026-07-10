// Build SummaryContext bag for writeRunSummary — extracted from BlackboardRunner.

import type { SummaryContext } from "./runSummaryWriter.js";
import type { PerAgentStat, RunSummary } from "./summary.js";
import type { ExitContract } from "./types.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import type { TranscriptEntry, SwarmEvent } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { RunStateObserver } from "./RunStateObserver.js";

export interface WriteRunSummaryBagHost {
  active: RunConfig;
  runBootedAt: number;
  gitPorcelainAtRunStart: string;
  runStartedAt: number | undefined;
  tickAccumulatorActiveElapsedMs: number | undefined;
  isStopping: () => boolean;
  isUserStopRequested: () => boolean;
  isWasDrained: () => boolean;
  getLastSummary: () => RunSummary | undefined;
  terminationReason: string | undefined;
  completionDetail: string | undefined;
  staleEventCount: number;
  auditInvocations: number;
  currentTier: number;
  tiersCompleted: number;
  tierHistory: SummaryContext["tierHistory"];
  contract: ExitContract | undefined;
  transcript: TranscriptEntry[];
  agentStats: PerAgentStat[];
  boardCounts: { committed: number; skipped: number; stale: number; total: number };
  gitStatus: { porcelain: string; changedFiles: number };
  errorTracker: ClassifiedError[];
  controlAdvice: SummaryContext["controlAdvice"];
  v2Observer: RunStateObserver;
  todoQueue: TodoQueue;
  cloneContract: (c: ExitContract) => ExitContract;
  lastSummarySetter: (s: RunSummary) => void;
  emit: (e: SwarmEvent) => void;
  appendSystem: SummaryContext["appendSystem"];
}

export function buildWriteRunSummaryContext(
  host: WriteRunSummaryBagHost,
  crashMessage: string | undefined,
): SummaryContext {
  return {
    cfg: host.active,
    runBootedAt: host.runBootedAt,
    gitPorcelainAtRunStart: host.gitPorcelainAtRunStart,
    runStartedAt: host.runStartedAt,
    tickAccumulatorActiveElapsedMs: host.tickAccumulatorActiveElapsedMs,
    stopping: host.isStopping() || host.isUserStopRequested(),
    userStopRequested: host.isUserStopRequested(),
    wasDrained: host.isWasDrained(),
    getLastSummary: () => host.getLastSummary(),
    crashMessage,
    terminationReason: host.terminationReason,
    completionDetail: host.completionDetail,
    staleEventCount: host.staleEventCount,
    auditInvocations: host.auditInvocations,
    currentTier: host.currentTier,
    tiersCompleted: host.tiersCompleted,
    tierHistory: host.tierHistory,
    contract: host.contract,
    transcript: host.transcript,
    agentStats: host.agentStats,
    boardCounts: host.boardCounts,
    gitStatus: host.gitStatus,
    errorTracker: host.errorTracker,
    controlAdvice: host.controlAdvice,
    v2State: {
      phase: host.v2Observer.getState().phase,
      enteredAt: host.v2Observer.getState().enteredAt,
      detail: host.v2Observer.getState().detail,
      pausedReason: host.v2Observer.getState().pausedReason,
    },
    v2QueueState: { counts: host.todoQueue.counts() },
    cloneContract: (c) => host.cloneContract(c),
    lastSummarySetter: (s) => host.lastSummarySetter(s),
    emit: host.emit,
    appendSystem: (msg, ...args) => host.appendSystem(msg, ...args),
  };
}
