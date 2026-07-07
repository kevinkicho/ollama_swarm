// Restore TodoQueue + FindingsLog from a blackboard-state.json snapshot (Unit 57+).

import type { TodoQueue, QueuedTodo } from "./TodoQueue.js";
import type { FindingsLog } from "./FindingsLog.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import type { Todo } from "./types.js";

export interface BoardRestoreResult {
  restoredTodos: number;
  pending: number;
  pendingCommit: number;
  failed: number;
  skipped: number;
  findings: number;
}

/** Map wire-protocol Todo status back to V2 queue status. */
export function wireTodoToQueuedTodo(wire: Todo): QueuedTodo | null {
  let status: QueuedTodo["status"];
  switch (wire.status) {
    case "open":
      status = "pending";
      break;
    case "claimed":
      // Claims do not survive server restart — re-queue as pending.
      status = "pending";
      break;
    case "pending-commit":
      status = "pending-commit";
      break;
    case "committed":
      status = "completed";
      break;
    case "stale":
      status = "failed";
      break;
    case "skipped":
      status = "skipped";
      break;
    default:
      return null;
  }

  const replanCount = wire.replanCount ?? 0;
  const endedAt =
    wire.status === "committed" ? wire.committedAt
    : wire.status === "skipped" || wire.status === "stale" ? Date.now()
    : undefined;

  return {
    id: wire.id,
    description: wire.description,
    expectedFiles: wire.expectedFiles.slice(),
    createdBy: wire.createdBy,
    createdAt: wire.createdAt,
    status,
    retries: replanCount,
    ...(wire.criterionId ? { criterionId: wire.criterionId } : {}),
    ...(wire.criteriaIds && wire.criteriaIds.length > 0
      ? { criteriaIds: wire.criteriaIds.slice() }
      : {}),
    ...(wire.expectedAnchors && wire.expectedAnchors.length > 0
      ? { expectedAnchors: wire.expectedAnchors.slice() }
      : {}),
    ...(wire.kind ? { kind: wire.kind } : {}),
    ...(wire.command ? { command: wire.command } : {}),
    ...(wire.contextFiles && wire.contextFiles.length > 0
      ? { contextFiles: wire.contextFiles.slice() }
      : {}),
    ...(status === "failed" && wire.staleReason ? { reason: wire.staleReason } : {}),
    ...(status === "skipped" && wire.skippedReason ? { reason: wire.skippedReason } : {}),
    ...(status === "completed" && endedAt !== undefined ? { endedAt } : {}),
    ...(status === "skipped" && endedAt !== undefined ? { endedAt } : {}),
    ...(status === "failed" && endedAt !== undefined ? { endedAt } : {}),
    ...(status === "pending-commit" && wire.proposedHunks
      ? { proposedHunks: wire.proposedHunks, proposedFiles: wire.proposedFiles?.slice() ?? wire.expectedFiles.slice() }
      : {}),
  };
}

export function countActionableTodos(todos: readonly Todo[]): number {
  return todos.filter(
    (t) => t.status === "open" || t.status === "claimed" || t.status === "pending-commit",
  ).length;
}

export function restoreBoardFromSnapshot(args: {
  snap: BlackboardStateSnapshot;
  todoQueue: TodoQueue;
  findings: FindingsLog;
}): BoardRestoreResult {
  const { snap, todoQueue, findings } = args;
  todoQueue.clear();
  findings.clear();

  const restored: QueuedTodo[] = [];
  for (const wire of snap.board?.todos ?? []) {
    const qt = wireTodoToQueuedTodo(wire);
    if (!qt) continue;
    restored.push(qt);
  }
  todoQueue.restore(restored);

  for (const f of snap.board?.findings ?? []) {
    findings.restore({
      id: f.id,
      agentId: f.agentId,
      text: f.text,
      createdAt: f.createdAt,
    });
  }

  const counts = todoQueue.counts();
  return {
    restoredTodos: restored.length,
    pending: counts.pending,
    pendingCommit: counts.pendingCommit,
    failed: counts.failed,
    skipped: counts.skipped,
    findings: findings.list().length,
  };
}