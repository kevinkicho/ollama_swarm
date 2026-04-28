// V2 cutover Phase 2c tests: boardWireCompat translation layer. Pure
// functions that map V2 TodoQueue shapes onto the V1 wire-protocol
// vocabulary the UI consumes. Translation correctness is the load-
// bearing contract — any drift here surfaces as wrong UI state.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  v2QueueTodoToWireTodo,
  v2QueueCountsToWireCounts,
  buildWireSnapshot,
} from "./boardWireCompat.js";
import type { QueuedTodo } from "./TodoQueue.js";
import type { Finding } from "./types.js";

const IN_PROGRESS_TTL_MS = 10 * 60_000;

function makeQueued(overrides: Partial<QueuedTodo> = {}): QueuedTodo {
  return {
    id: "t1",
    description: "do thing",
    expectedFiles: ["a.ts"],
    createdBy: "planner",
    createdAt: 1000,
    status: "pending",
    retries: 0,
    ...overrides,
  };
}

describe("v2QueueTodoToWireTodo — status mapping", () => {
  it("pending → open", () => {
    const wire = v2QueueTodoToWireTodo(makeQueued({ status: "pending" }));
    assert.equal(wire.status, "open");
  });

  it("in-progress → claimed (with synthesized claim)", () => {
    const wire = v2QueueTodoToWireTodo(
      makeQueued({ status: "in-progress", workerId: "agent-2", startedAt: 5_000 }),
    );
    assert.equal(wire.status, "claimed");
    assert.ok(wire.claim);
    assert.equal(wire.claim?.todoId, "t1");
    assert.equal(wire.claim?.agentId, "agent-2");
    assert.equal(wire.claim?.claimedAt, 5_000);
    assert.equal(wire.claim?.expiresAt, 5_000 + IN_PROGRESS_TTL_MS);
    assert.deepEqual(wire.claim?.fileHashes, {});
  });

  it("in-progress without workerId or startedAt → claim NOT synthesized", () => {
    const wire = v2QueueTodoToWireTodo(makeQueued({ status: "in-progress" }));
    assert.equal(wire.status, "claimed");
    assert.equal(wire.claim, undefined);
  });

  it("completed → committed (with committedAt from endedAt)", () => {
    const wire = v2QueueTodoToWireTodo(
      makeQueued({ status: "completed", endedAt: 7_000 }),
    );
    assert.equal(wire.status, "committed");
    assert.equal(wire.committedAt, 7_000);
  });

  it("failed → stale (with staleReason from reason)", () => {
    const wire = v2QueueTodoToWireTodo(
      makeQueued({ status: "failed", reason: "anchor not found", endedAt: 8_000 }),
    );
    assert.equal(wire.status, "stale");
    assert.equal(wire.staleReason, "anchor not found");
  });

  it("skipped → skipped (with skippedReason from reason)", () => {
    const wire = v2QueueTodoToWireTodo(
      makeQueued({ status: "skipped", reason: "out of scope", endedAt: 9_000 }),
    );
    assert.equal(wire.status, "skipped");
    assert.equal(wire.skippedReason, "out of scope");
  });
});

describe("v2QueueTodoToWireTodo — extended fields pass through", () => {
  it("forwards expectedAnchors / kind / command / preferredTag / criterionId", () => {
    const wire = v2QueueTodoToWireTodo(
      makeQueued({
        criterionId: "c1",
        expectedAnchors: ["anchor-a", "anchor-b"],
        kind: "build",
        command: "bun run build",
        preferredTag: "tests-expert",
      }),
    );
    assert.equal(wire.criterionId, "c1");
    assert.deepEqual(wire.expectedAnchors, ["anchor-a", "anchor-b"]);
    assert.equal(wire.kind, "build");
    assert.equal(wire.command, "bun run build");
    assert.equal(wire.preferredTag, "tests-expert");
  });

  it("omits absent optional fields (no spurious undefined keys)", () => {
    const wire = v2QueueTodoToWireTodo(makeQueued());
    assert.equal("expectedAnchors" in wire, false);
    assert.equal("kind" in wire, false);
    assert.equal("command" in wire, false);
    assert.equal("preferredTag" in wire, false);
    assert.equal("criterionId" in wire, false);
    assert.equal("claim" in wire, false);
  });

  it("returns defensive copies of expectedFiles + expectedAnchors", () => {
    const qt = makeQueued({
      expectedFiles: ["a.ts", "b.ts"],
      expectedAnchors: ["x"],
    });
    const wire = v2QueueTodoToWireTodo(qt);
    wire.expectedFiles.push("MUTATED");
    wire.expectedAnchors!.push("MUTATED");
    assert.deepEqual(qt.expectedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(qt.expectedAnchors, ["x"]);
  });

  it("forwards retries → replanCount", () => {
    const wire = v2QueueTodoToWireTodo(makeQueued({ retries: 3 }));
    assert.equal(wire.replanCount, 3);
  });
});

describe("v2QueueCountsToWireCounts — field name remap", () => {
  it("pending→open, inProgress→claimed, completed→committed, failed→stale, skipped→skipped, total→total", () => {
    const wire = v2QueueCountsToWireCounts({
      pending: 1,
      inProgress: 2,
      completed: 3,
      failed: 4,
      skipped: 5,
      total: 15,
    });
    assert.deepEqual(wire, {
      open: 1,
      claimed: 2,
      committed: 3,
      stale: 4,
      skipped: 5,
      total: 15,
    });
  });

  it("zeros pass through unchanged", () => {
    const wire = v2QueueCountsToWireCounts({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    });
    assert.deepEqual(wire, {
      open: 0,
      claimed: 0,
      committed: 0,
      stale: 0,
      skipped: 0,
      total: 0,
    });
  });
});

describe("buildWireSnapshot", () => {
  it("translates each todo + each finding into wire shapes", () => {
    const todos: QueuedTodo[] = [
      makeQueued({ id: "t1", status: "pending" }),
      makeQueued({ id: "t2", status: "completed", endedAt: 5 }),
    ];
    const findings: Finding[] = [
      { id: "f1", agentId: "a", text: "note", createdAt: 1 },
    ];
    const snap = buildWireSnapshot(todos, findings);
    assert.equal(snap.todos.length, 2);
    assert.equal(snap.todos[0].status, "open");
    assert.equal(snap.todos[1].status, "committed");
    assert.equal(snap.findings.length, 1);
    assert.equal(snap.findings[0].text, "note");
  });

  it("returns defensive copies of findings (mutation doesn't reach caller)", () => {
    const findings: Finding[] = [
      { id: "f1", agentId: "a", text: "original", createdAt: 1 },
    ];
    const snap = buildWireSnapshot([], findings);
    snap.findings[0].text = "MUTATED";
    assert.equal(findings[0].text, "original");
  });

  it("empty inputs produce empty snapshot arrays", () => {
    const snap = buildWireSnapshot([], []);
    assert.deepEqual(snap.todos, []);
    assert.deepEqual(snap.findings, []);
  });
});
