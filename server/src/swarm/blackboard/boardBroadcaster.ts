// Wire-event broadcaster for blackboard runs. Forwards each
// BoardEvent as a SwarmEvent and sends a debounced full snapshot
// every snapshotDebounceMs after mutations so bursts coalesce.
//
// V2 cutover Phase 2c (2026-04-28): originally bound to a V1 Board
// instance via bindBoard(); now takes a snapshot getter callback so
// the source can be the V2 TodoQueue (translated to wire shape via
// boardWireCompat.ts).

import type { SwarmEvent } from "../../types.js";
import type { BoardEvent, BoardSnapshot, BoardCounts } from "./types.js";

export interface BoardBroadcaster {
  // Forward this event upstream; also schedule a debounced snapshot
  // so the post-mutation full state lands shortly.
  emit: (ev: BoardEvent) => void;
  // Provide the snapshot+counts pair the broadcaster will sample on
  // the debounce timer. Caller assembles the data from whichever
  // queue/log it owns.
  bindSnapshotSource: (getSnapshot: () => { snapshot: BoardSnapshot; counts: BoardCounts }) => void;
  // Cancel any pending snapshot and send a fresh one immediately.
  // Used at run end so the UI never lags behind the final state.
  flushSnapshot: () => void;
  // Cancel pending timer and drop the snapshot source. Call on stop.
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
  let getSnapshot: (() => { snapshot: BoardSnapshot; counts: BoardCounts }) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const sendSnapshot = () => {
    if (!getSnapshot) return;
    const { snapshot, counts } = getSnapshot();
    broadcast({ type: "board_state", snapshot, counts });
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
    getSnapshot = null;
  };

  return {
    emit,
    bindSnapshotSource(fn) {
      getSnapshot = fn;
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
        // Audit fix (2026-04-28): forward anchor revisions to the wire.
        // Both BoardEvent.todo_replanned + the wire SwarmEvent variant
        // declare expectedAnchors as optional; without this passthrough
        // the UI's applyReplan handler never sees it.
        ...(ev.expectedAnchors ? { expectedAnchors: ev.expectedAnchors } : {}),
      };
    case "finding_posted":
      return { type: "board_finding_posted", finding: ev.finding };
  }
}
