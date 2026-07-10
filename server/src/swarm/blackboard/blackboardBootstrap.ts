// BlackboardRunner constructor wiring — board broadcaster, snapshot scheduler, todo wrappers.

import type { BoardBroadcaster } from "./boardBroadcaster.js";
import { createBoardBroadcaster } from "./boardBroadcaster.js";
import { FindingsLog } from "./FindingsLog.js";
import { StateSnapshotScheduler } from "./stateSnapshotScheduler.js";
import {
  makeTodoQueueWrappers,
  type TodoQueueWrappers,
} from "./todoQueueWrappers.js";
import {
  buildWireSnapshot,
  v2QueueCountsToWireCounts,
} from "./boardWireCompat.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { RunStateObserver } from "./RunStateObserver.js";
import type { SwarmEvent } from "../../types.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import type { ExitContract } from "./types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PerAgentStat } from "./summary.js";

export interface BlackboardBootstrapInput {
  emit: (e: SwarmEvent) => void;
  todoQueue: TodoQueue;
  v2Observer: RunStateObserver;
  getPhase: () => string;
  getRound: () => number;
  getRunBootedAt: () => number | undefined;
  getRunStartedAt: () => number | undefined;
  getTickAccumulatorActiveElapsedMs: () => number | undefined;
  getActive: () => RunConfig | undefined;
  getContract: () => ExitContract | undefined;
  cloneContract: (c: ExitContract) => ExitContract;
  boardSnapshot: () => unknown;
  buildPerAgentStats: () => PerAgentStat[];
  getStaleEventCount: () => number;
  getAuditInvocations: () => number;
  getAgentRoster: () => Array<{ id: string; index: number }>;
  getTerminationReason: () => string | undefined;
  getCompletionDetail: () => string | undefined;
  getCurrentTier: () => number;
  getTiersCompleted: () => number;
  getTierHistory: () => unknown[];
  scheduleStateWrite: () => void;
  bumpStaleAndEnqueueReplan: (todoId: string) => void;
}

export interface BlackboardBootstrapResult {
  boardBroadcaster: BoardBroadcaster;
  findings: FindingsLog;
  stateSnapshotScheduler: StateSnapshotScheduler;
  wrappers: TodoQueueWrappers;
}

/** Wire broadcaster, findings log, snapshot scheduler, and mutation wrappers. */
export function bootstrapBlackboardRunner(
  input: BlackboardBootstrapInput,
): BlackboardBootstrapResult {
  const boardBroadcaster = createBoardBroadcaster(input.emit);
  const findings = new FindingsLog();
  const stateSnapshotScheduler = new StateSnapshotScheduler(
    () => ({
      phase: input.getPhase() as any,
      round: input.getRound(),
      runBootedAt: input.getRunBootedAt(),
      runStartedAt: input.getRunStartedAt(),
      tickAccumulatorActiveElapsedMs: input.getTickAccumulatorActiveElapsedMs(),
      active: input.getActive(),
      contract: input.getContract(),
      cloneContract: (c: ExitContract) => input.cloneContract(c),
      boardSnapshot: () => input.boardSnapshot() as any,
      buildPerAgentStats: () => input.buildPerAgentStats(),
      staleEventCount: input.getStaleEventCount(),
      auditInvocations: input.getAuditInvocations(),
      agentRoster: input.getAgentRoster(),
      terminationReason: input.getTerminationReason(),
      completionDetail: input.getCompletionDetail(),
      currentTier: input.getCurrentTier(),
      tiersCompleted: input.getTiersCompleted(),
      tierHistory: input.getTierHistory() as any,
    }),
    () => input.getActive()?.localPath,
  );

  boardBroadcaster.bindSnapshotSource(() => ({
    snapshot: buildWireSnapshot(input.todoQueue.list(), findings.list()),
    counts: v2QueueCountsToWireCounts(input.todoQueue.counts()),
  }));

  const wrappers = makeTodoQueueWrappers({
    todoQueue: input.todoQueue,
    findings,
    emit: (ev) => boardBroadcaster.emit(ev),
    scheduleStateWrite: () => input.scheduleStateWrite(),
    onTerminal: (kind, remaining) => {
      input.v2Observer.apply({
        type: kind === "committed" ? "todo-committed" : "todo-skipped",
        ts: Date.now(),
        remainingTodos: remaining,
      });
    },
    onFailed: (todoId) => {
      input.bumpStaleAndEnqueueReplan(todoId);
    },
  });

  return {
    boardBroadcaster,
    findings,
    stateSnapshotScheduler,
    wrappers,
  };
}
