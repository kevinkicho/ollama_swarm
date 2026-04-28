// Unit tests for the BlackboardRunner mutation wrappers, exercised
// in isolation via makeTodoQueueWrappers + a real TodoQueue +
// FindingsLog + a recording emit/callback set. Verifies each wrapper
// performs its mutation, emits the right BoardEvent, schedules a
// state write, and fires the correct lifecycle callback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTodoQueueWrappers } from "./todoQueueWrappers.js";
import { TodoQueue } from "./TodoQueue.js";
import { FindingsLog } from "./FindingsLog.js";
import type { BoardEvent } from "./types.js";

interface Recorder {
  emits: BoardEvent[];
  stateWrites: number;
  terminals: Array<{ kind: "committed" | "skipped"; remaining: number }>;
  failed: string[];
}

function setup() {
  const todoQueue = new TodoQueue();
  const findings = new FindingsLog();
  const rec: Recorder = { emits: [], stateWrites: 0, terminals: [], failed: [] };
  const wrappers = makeTodoQueueWrappers({
    todoQueue,
    findings,
    emit: (ev) => rec.emits.push(ev),
    scheduleStateWrite: () => {
      rec.stateWrites++;
    },
    onTerminal: (kind, remaining) => rec.terminals.push({ kind, remaining }),
    onFailed: (id) => rec.failed.push(id),
  });
  return { wrappers, todoQueue, findings, rec };
}

describe("todoQueueWrappers — postTodoQ", () => {
  it("stores the todo, returns its id, emits todo_posted, schedules write", () => {
    const { wrappers, todoQueue, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "first",
      expectedFiles: ["a.ts"],
      createdBy: "planner",
      createdAt: 100,
    });
    assert.match(id, /^t\d+$/);
    assert.equal(todoQueue.counts().pending, 1);
    assert.equal(rec.stateWrites, 1);
    assert.equal(rec.emits.length, 1);
    const ev = rec.emits[0];
    assert.equal(ev.type, "todo_posted");
    if (ev.type !== "todo_posted") throw new Error("type narrow");
    assert.equal(ev.todo.id, id);
    assert.equal(ev.todo.description, "first");
    assert.equal(ev.todo.status, "open");
  });

  it("forwards extended fields (anchors, kind, command, preferredTag)", () => {
    const { wrappers, rec } = setup();
    wrappers.postTodoQ({
      description: "build docs",
      expectedFiles: ["docs/api.md"],
      createdBy: "planner",
      createdAt: 100,
      expectedAnchors: ["## API"],
      kind: "build",
      command: "bun run docs:api",
      preferredTag: "docs-expert",
    });
    const ev = rec.emits[0];
    if (ev.type !== "todo_posted") throw new Error("type narrow");
    assert.deepEqual(ev.todo.expectedAnchors, ["## API"]);
    assert.equal(ev.todo.kind, "build");
    assert.equal(ev.todo.command, "bun run docs:api");
    assert.equal(ev.todo.preferredTag, "docs-expert");
  });
});

describe("todoQueueWrappers — dequeueTodoQ", () => {
  it("returns null + no events when queue is empty", () => {
    const { wrappers, rec } = setup();
    const out = wrappers.dequeueTodoQ("worker-2");
    assert.equal(out, null);
    assert.equal(rec.emits.length, 0);
    assert.equal(rec.stateWrites, 0);
  });

  it("returns the todo + emits todo_claimed with synthesized claim", () => {
    const { wrappers, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    rec.emits.length = 0;
    rec.stateWrites = 0;
    const out = wrappers.dequeueTodoQ("worker-2");
    assert.ok(out);
    assert.equal(out!.id, id);
    assert.equal(out!.workerId, "worker-2");
    assert.equal(rec.emits.length, 1);
    const ev = rec.emits[0];
    assert.equal(ev.type, "todo_claimed");
    if (ev.type !== "todo_claimed") throw new Error("type narrow");
    assert.equal(ev.todoId, id);
    assert.equal(ev.claim.agentId, "worker-2");
    assert.equal(rec.stateWrites, 1);
  });

  it("with preferTag picks matching todo first", () => {
    const { wrappers } = setup();
    const idGeneric = wrappers.postTodoQ({
      description: "g",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 1,
    });
    const idTagged = wrappers.postTodoQ({
      description: "t",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 2,
      preferredTag: "tests",
    });
    const out = wrappers.dequeueTodoQ("w", "tests");
    assert.equal(out?.id, idTagged);
    // Generic still pending.
    const out2 = wrappers.dequeueTodoQ("w");
    assert.equal(out2?.id, idGeneric);
  });
});

describe("todoQueueWrappers — completeTodoQ", () => {
  it("transitions to completed, emits todo_committed, fires onTerminal with remaining=0", () => {
    const { wrappers, todoQueue, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 1,
    });
    wrappers.dequeueTodoQ("w");
    rec.emits.length = 0;
    rec.stateWrites = 0;
    rec.terminals.length = 0;
    wrappers.completeTodoQ(id);
    assert.equal(todoQueue.get(id)?.status, "completed");
    assert.equal(rec.emits.length, 1);
    assert.equal(rec.emits[0].type, "todo_committed");
    assert.equal(rec.stateWrites, 1);
    assert.deepEqual(rec.terminals, [{ kind: "committed", remaining: 0 }]);
  });

  it("onTerminal sees CURRENT pending count when other todos remain", () => {
    const { wrappers, rec } = setup();
    wrappers.postTodoQ({ description: "a", expectedFiles: [], createdBy: "p", createdAt: 1 });
    const idB = wrappers.postTodoQ({ description: "b", expectedFiles: [], createdBy: "p", createdAt: 2 });
    wrappers.postTodoQ({ description: "c", expectedFiles: [], createdBy: "p", createdAt: 3 });
    wrappers.dequeueTodoQ("w");
    wrappers.dequeueTodoQ("w");
    rec.terminals.length = 0;
    wrappers.completeTodoQ(idB);
    assert.equal(rec.terminals[0].remaining, 1);
  });

  it("throws if todo isn't in-progress (lost-race after reap)", () => {
    const { wrappers, todoQueue } = setup();
    const id = wrappers.postTodoQ({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 1,
    });
    wrappers.dequeueTodoQ("w");
    // Reaper transitions to failed.
    todoQueue.fail(id, "reaped");
    assert.throws(() => wrappers.completeTodoQ(id), /Cannot complete todo/);
  });
});

describe("todoQueueWrappers — failTodoQ", () => {
  it("transitions to failed, emits todo_stale with retries, fires onFailed", () => {
    const { wrappers, todoQueue, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 1,
    });
    wrappers.dequeueTodoQ("w");
    rec.emits.length = 0;
    rec.stateWrites = 0;
    wrappers.failTodoQ(id, "anchor not found");
    assert.equal(todoQueue.get(id)?.status, "failed");
    assert.equal(rec.emits.length, 1);
    const ev = rec.emits[0];
    if (ev.type !== "todo_stale") throw new Error("type narrow");
    assert.equal(ev.reason, "anchor not found");
    assert.equal(ev.replanCount, 1);
    assert.equal(rec.stateWrites, 1);
    assert.deepEqual(rec.failed, [id]);
  });
});

describe("todoQueueWrappers — skipTodoQ", () => {
  it("transitions any non-terminal → skipped, emits todo_skipped, fires onTerminal", () => {
    const { wrappers, todoQueue, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 1,
    });
    rec.emits.length = 0;
    rec.terminals.length = 0;
    wrappers.skipTodoQ(id, "out of scope");
    assert.equal(todoQueue.get(id)?.status, "skipped");
    assert.equal(rec.emits.length, 1);
    const ev = rec.emits[0];
    if (ev.type !== "todo_skipped") throw new Error("type narrow");
    assert.equal(ev.reason, "out of scope");
    assert.deepEqual(rec.terminals, [{ kind: "skipped", remaining: 0 }]);
  });
});

describe("todoQueueWrappers — resetTodoQ", () => {
  it("transitions failed → pending, emits todo_replanned with new fields", () => {
    const { wrappers, todoQueue, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "old",
      expectedFiles: ["a.ts"],
      createdBy: "p",
      createdAt: 1,
    });
    wrappers.dequeueTodoQ("w");
    wrappers.failTodoQ(id, "boom");
    rec.emits.length = 0;
    rec.stateWrites = 0;
    wrappers.resetTodoQ(id, {
      description: "new desc",
      expectedFiles: ["b.ts"],
      expectedAnchors: ["new-anchor"],
    });
    assert.equal(todoQueue.get(id)?.status, "pending");
    assert.equal(todoQueue.get(id)?.description, "new desc");
    assert.equal(rec.emits.length, 1);
    const ev = rec.emits[0];
    if (ev.type !== "todo_replanned") throw new Error("type narrow");
    assert.equal(ev.description, "new desc");
    assert.deepEqual(ev.expectedFiles, ["b.ts"]);
    assert.deepEqual(ev.expectedAnchors, ["new-anchor"]);
    assert.equal(rec.stateWrites, 1);
  });

  it("emits replanned without expectedAnchors when none set", () => {
    const { wrappers, rec } = setup();
    const id = wrappers.postTodoQ({
      description: "x",
      expectedFiles: ["a.ts"],
      createdBy: "p",
      createdAt: 1,
    });
    wrappers.dequeueTodoQ("w");
    wrappers.failTodoQ(id, "boom");
    rec.emits.length = 0;
    wrappers.resetTodoQ(id);
    const ev = rec.emits[0];
    if (ev.type !== "todo_replanned") throw new Error("type narrow");
    assert.equal("expectedAnchors" in ev, false);
  });
});

describe("todoQueueWrappers — postFindingQ", () => {
  it("stores the finding + emits finding_posted + schedules write", () => {
    const { wrappers, findings, rec } = setup();
    wrappers.postFindingQ({ agentId: "a-1", text: "noticed X", createdAt: 100 });
    assert.equal(findings.list().length, 1);
    assert.equal(rec.emits.length, 1);
    const ev = rec.emits[0];
    if (ev.type !== "finding_posted") throw new Error("type narrow");
    assert.equal(ev.finding.text, "noticed X");
    assert.equal(rec.stateWrites, 1);
  });

  it("propagates findings.post throw on empty text", () => {
    const { wrappers, rec } = setup();
    assert.throws(() =>
      wrappers.postFindingQ({ agentId: "a", text: "  ", createdAt: 1 }),
    /cannot be empty/,
    );
    assert.equal(rec.emits.length, 0, "no event on failed post");
  });
});
