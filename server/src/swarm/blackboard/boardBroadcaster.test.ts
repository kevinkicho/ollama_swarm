// Tests for the V2 cutover-era boardBroadcaster (snapshot-getter
// API, not the older bindBoard). Covers: emit forwards events,
// debounced snapshot fires once after a burst, flushSnapshot
// cancels pending + sends immediately, dispose stops further
// snapshots, idempotent dispose, snapshot before bind is silent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBoardBroadcaster,
  type BoardBroadcaster,
} from "./boardBroadcaster.js";
import type { SwarmEvent } from "../../types.js";
import type { BoardSnapshot, BoardCounts } from "./types.js";

function makeSnapshot(): { snapshot: BoardSnapshot; counts: BoardCounts } {
  return {
    snapshot: { todos: [], findings: [] },
    counts: { open: 0, claimed: 0, committed: 0, stale: 0, skipped: 0, total: 0 },
  };
}

function setup(opts: { debounceMs?: number } = {}) {
  const events: SwarmEvent[] = [];
  const bb = createBoardBroadcaster((ev) => events.push(ev), {
    snapshotDebounceMs: opts.debounceMs ?? 20,
  });
  return { bb, events };
}

describe("boardBroadcaster — emit forwards events", () => {
  it("translates a BoardEvent into a SwarmEvent on every emit", () => {
    const { bb, events } = setup();
    bb.bindSnapshotSource(makeSnapshot);
    bb.emit({
      type: "todo_posted",
      todo: {
        id: "t1",
        description: "x",
        expectedFiles: [],
        createdBy: "p",
        createdAt: 1,
        status: "open",
        replanCount: 0,
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "board_todo_posted");
  });

  it("emits the swarm-event for each BoardEvent variant", () => {
    const { bb, events } = setup();
    bb.bindSnapshotSource(makeSnapshot);
    bb.emit({ type: "todo_committed", todoId: "t1" });
    bb.emit({ type: "todo_skipped", todoId: "t2", reason: "x" });
    bb.emit({
      type: "todo_stale",
      todoId: "t3",
      reason: "x",
      replanCount: 1,
    });
    bb.emit({
      type: "finding_posted",
      finding: { id: "f1", agentId: "a", text: "n", createdAt: 1 },
    });
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "board_todo_committed",
      "board_todo_skipped",
      "board_todo_stale",
      "board_finding_posted",
    ]);
  });
});

describe("boardBroadcaster — debounced snapshot", () => {
  it("fires one snapshot after the debounce window for a single emit", async () => {
    const { bb, events } = setup({ debounceMs: 15 });
    let snapshotCallCount = 0;
    bb.bindSnapshotSource(() => {
      snapshotCallCount++;
      return makeSnapshot();
    });
    bb.emit({ type: "todo_committed", todoId: "t1" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(snapshotCallCount, 1);
    const snaps = events.filter((e) => e.type === "board_state");
    assert.equal(snaps.length, 1);
  });

  it("coalesces a burst of emits into one snapshot", async () => {
    const { bb, events } = setup({ debounceMs: 15 });
    let snapshotCallCount = 0;
    bb.bindSnapshotSource(() => {
      snapshotCallCount++;
      return makeSnapshot();
    });
    for (let i = 0; i < 10; i++) {
      bb.emit({ type: "todo_committed", todoId: `t${i}` });
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(snapshotCallCount, 1, "snapshot getter only invoked once after burst");
    const snaps = events.filter((e) => e.type === "board_state");
    assert.equal(snaps.length, 1);
    // 10 individual events + 1 snapshot = 11 total
    assert.equal(events.length, 11);
  });
});

describe("boardBroadcaster — flushSnapshot", () => {
  it("cancels pending debounce + sends snapshot immediately", () => {
    const { bb, events } = setup({ debounceMs: 1_000 });
    let snapshotCallCount = 0;
    bb.bindSnapshotSource(() => {
      snapshotCallCount++;
      return makeSnapshot();
    });
    bb.emit({ type: "todo_committed", todoId: "t1" });
    assert.equal(snapshotCallCount, 0, "no snapshot before flush — still in debounce");
    bb.flushSnapshot();
    assert.equal(snapshotCallCount, 1);
    const snaps = events.filter((e) => e.type === "board_state");
    assert.equal(snaps.length, 1);
  });

  it("flushSnapshot with no pending emit still sends a fresh snapshot", () => {
    const { bb, events } = setup();
    bb.bindSnapshotSource(makeSnapshot);
    bb.flushSnapshot();
    const snaps = events.filter((e) => e.type === "board_state");
    assert.equal(snaps.length, 1);
  });

  it("flushSnapshot before bindSnapshotSource silently does nothing", () => {
    const { bb, events } = setup();
    assert.doesNotThrow(() => bb.flushSnapshot());
    assert.equal(events.length, 0);
  });
});

describe("boardBroadcaster — dispose", () => {
  it("dispose stops debounced snapshots from firing", async () => {
    const { bb, events } = setup({ debounceMs: 15 });
    bb.bindSnapshotSource(makeSnapshot);
    bb.emit({ type: "todo_committed", todoId: "t1" });
    bb.dispose();
    await new Promise((r) => setTimeout(r, 30));
    const snaps = events.filter((e) => e.type === "board_state");
    assert.equal(snaps.length, 0, "dispose cancelled the debounced snapshot");
  });

  it("dispose drops the snapshot source — flushSnapshot after dispose is silent", () => {
    const { bb, events } = setup();
    bb.bindSnapshotSource(makeSnapshot);
    bb.dispose();
    bb.flushSnapshot();
    const snaps = events.filter((e) => e.type === "board_state");
    assert.equal(snaps.length, 0);
  });

  it("dispose is idempotent — calling twice does not throw", () => {
    const { bb } = setup();
    bb.bindSnapshotSource(makeSnapshot);
    bb.dispose();
    assert.doesNotThrow(() => bb.dispose());
  });
});

describe("boardBroadcaster — snapshot getter is invoked at fire time, not bind time", () => {
  it("captures CURRENT state at snapshot time, not stale state from bind time", () => {
    const { bb, events } = setup();
    let counter = 0;
    bb.bindSnapshotSource(() => {
      counter++;
      return {
        snapshot: { todos: [], findings: [] },
        counts: { open: counter, claimed: 0, committed: 0, stale: 0, skipped: 0, total: counter },
      };
    });
    bb.flushSnapshot();
    bb.flushSnapshot();
    bb.flushSnapshot();
    const snaps = events.filter(
      (e): e is Extract<SwarmEvent, { type: "board_state" }> => e.type === "board_state",
    );
    assert.equal(snaps.length, 3);
    assert.equal(snaps[0].counts.open, 1);
    assert.equal(snaps[1].counts.open, 2);
    assert.equal(snaps[2].counts.open, 3);
  });
});

// Smoke: the public surface compiles to the documented interface.
describe("BoardBroadcaster type — exhaustive shape", () => {
  it("exposes emit, bindSnapshotSource, flushSnapshot, dispose", () => {
    const { bb } = setup();
    const fn: BoardBroadcaster = bb;
    assert.equal(typeof fn.emit, "function");
    assert.equal(typeof fn.bindSnapshotSource, "function");
    assert.equal(typeof fn.flushSnapshot, "function");
    assert.equal(typeof fn.dispose, "function");
  });
});
