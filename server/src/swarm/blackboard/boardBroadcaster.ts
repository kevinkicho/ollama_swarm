import type { SwarmEvent } from "../../types.js";
import type { Board } from "./Board.js";
import type { BoardEvent } from "./types.js";

export interface BoardBroadcaster {
  // Pass this to `new Board({ emit })`. Each BoardEvent is forwarded as a
  // SwarmEvent and a full snapshot is scheduled on a trailing-edge timer so
  // bursts of mutations coalesce into one snapshot.
  emit: (ev: BoardEvent) => void;
  // Must be called after the Board is constructed so snapshots can read state.
  bindBoard: (board: Board) => void;
  // Cancel any pending snapshot and send a fresh one immediately. Used at run
  // end so the UI never lags behind the final board state.
  flushSnapshot: () => void;
  // Cancel pending timer and drop the board reference. Call on swarm stop.
  dispose: () => void;
}

export interface BoardBroadcasterOpts {
  snapshotDebounceMs?: number;
}

export function createBoardBroadcaster(
  broadcast: (ev: SwarmEvent) => void,
  opts: BoardBroadcasterOpts = {},
): BoardBroadcaster {
  const debounceMs = opts.snapshotDebounceMs ?? 500;
  let board: Board | null = null;
  let timer: NodeJS.Timeout | null = null;

  const sendSnapshot = () => {
    if (!board) return;
    broadcast({ type: "board_state", snapshot: board.snapshot(), counts: board.counts() });
  };

  const scheduleSnapshot = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      sendSnapshot();
    }, debounceMs);
    // Don't keep the process alive just for a snapshot timer.
    timer.unref?.();
  };

  const emit = (ev: BoardEvent) => {
    broadcast(toSwarmEvent(ev));
    scheduleSnapshot();
  };

  const flushSnapshot = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    sendSnapshot();
  };

  const dispose = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    board = null;
  };

  return {
    emit,
    bindBoard(b) {
      board = b;
    },
    flushSnapshot,
    dispose,
  };
}

function toSwarmEvent(ev: BoardEvent): SwarmEvent {
  switch (ev.type) {
    case "todo_posted":
      return { type: "board_todo_posted", todo: ev.todo };
    case "todo_claimed":
      return { type: "board_todo_claimed", todoId: ev.todoId, claim: ev.claim };
    case "todo_committed":
      return { type: "board_todo_committed", todoId: ev.todoId };
    case "todo_stale":
      return {
        type: "board_todo_stale",
        todoId: ev.todoId,
        reason: ev.reason,
        replanCount: ev.replanCount,
      };
    case "todo_skipped":
      return { type: "board_todo_skipped", todoId: ev.todoId, reason: ev.reason };
    case "todo_replanned":
      return {
        type: "board_todo_replanned",
        todoId: ev.todoId,
        description: ev.description,
        expectedFiles: ev.expectedFiles,
        replanCount: ev.replanCount,
      };
    case "finding_posted":
      return { type: "board_finding_posted", finding: ev.finding };
  }
}
