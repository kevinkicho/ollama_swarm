// V2 cutover Phase 2c (2026-04-28): translation layer between V2's
// TodoQueue and the wire protocol the UI consumes.
//
// The UI handlers in web/src/hooks/useSwarmSocket.ts speak Board's
// vocabulary — board_todo_posted/claimed/committed/stale/skipped/etc.
// Rather than rewrite the wire protocol + UI handlers in lockstep
// with the V2 cutover, we translate V2 events on the way out so the
// UI stays unchanged.
//
// This module dies in Phase 2g when the wire protocol is renamed
// to V2 vocabulary (todo_dequeued/completed/failed/etc.) and the
// UI handlers are updated. Until then, it's the bridge.

import type { QueuedTodoV2, TodoQueueCountsV2 } from "./TodoQueueV2.js";
import type { Todo, BoardSnapshot, BoardCounts, Claim, Finding } from "./types.js";

const IN_PROGRESS_TTL_MS = 10 * 60_000;

/** Translate a V2 queued todo to the V1 Todo wire shape. Status names
 *  map (pending→open, in-progress→claimed, completed→committed,
 *  failed→stale, skipped→skipped). Synthesizes a minimal Claim from
 *  workerId+startedAt for in-progress todos so UI claim displays work
 *  unchanged. Reason field maps to staleReason / skippedReason
 *  depending on the terminal status. */
export function v2QueueTodoToWireTodo(qt: QueuedTodoV2): Todo {
  const status =
    qt.status === "pending" ? "open"
      : qt.status === "in-progress" ? "claimed"
      : qt.status === "completed" ? "committed"
      : qt.status === "failed" ? "stale"
      : "skipped";
  let claim: Claim | undefined;
  if (qt.status === "in-progress" && qt.workerId && qt.startedAt !== undefined) {
    claim = {
      todoId: qt.id,
      agentId: qt.workerId,
      fileHashes: {},
      claimedAt: qt.startedAt,
      expiresAt: qt.startedAt + IN_PROGRESS_TTL_MS,
    };
  }
  return {
    id: qt.id,
    description: qt.description,
    expectedFiles: qt.expectedFiles.slice(),
    createdBy: qt.createdBy,
    createdAt: qt.createdAt,
    status,
    replanCount: qt.retries,
    ...(claim ? { claim } : {}),
    ...(qt.status === "completed" && qt.endedAt !== undefined ? { committedAt: qt.endedAt } : {}),
    ...(qt.status === "failed" && qt.reason ? { staleReason: qt.reason } : {}),
    ...(qt.status === "skipped" && qt.reason ? { skippedReason: qt.reason } : {}),
    ...(qt.criterionId ? { criterionId: qt.criterionId } : {}),
    ...(qt.expectedAnchors ? { expectedAnchors: qt.expectedAnchors.slice() } : {}),
    ...(qt.kind ? { kind: qt.kind } : {}),
    ...(qt.command ? { command: qt.command } : {}),
    ...(qt.preferredTag ? { preferredTag: qt.preferredTag } : {}),
  };
}

/** Translate V2 queue counts to V1 BoardCounts wire shape. */
export function v2QueueCountsToWireCounts(c: TodoQueueCountsV2): BoardCounts {
  return {
    open: c.pending,
    claimed: c.inProgress,
    committed: c.completed,
    stale: c.failed,
    skipped: c.skipped,
    total: c.total,
  };
}

/** Build a BoardSnapshot-shaped object from a V2 queue snapshot
 *  (for board_state wire events). Findings come separately since V2
 *  queue doesn't model them — the FindingsLog provides them. */
export function buildWireSnapshot(
  v2Todos: readonly QueuedTodoV2[],
  findings: readonly Finding[],
): BoardSnapshot {
  return {
    todos: v2Todos.map(v2QueueTodoToWireTodo),
    findings: findings.map((f) => ({ ...f })),
  };
}
