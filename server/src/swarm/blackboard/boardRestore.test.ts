import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TodoQueue } from "./TodoQueue.js";
import { FindingsLog } from "./FindingsLog.js";
import {
  countActionableTodos,
  restoreBoardFromSnapshot,
  wireTodoToQueuedTodo,
} from "./boardRestore.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import type { Todo } from "./types.js";

describe("wireTodoToQueuedTodo", () => {
  it("re-queues claimed todos as pending", () => {
    const qt = wireTodoToQueuedTodo({
      id: "t1",
      description: "x",
      expectedFiles: ["a.js"],
      createdBy: "p1",
      createdAt: 1,
      status: "claimed",
      claimedBy: "w1",
      claimedAt: 2,
    } as Todo);
    assert.ok(qt);
    assert.equal(qt!.status, "pending");
  });

  it("preserves pending-commit hunks", () => {
    const hunks = [{ op: "create", file: "routes/boe.js", content: "x" }];
    const qt = wireTodoToQueuedTodo({
      id: "t9",
      description: "route",
      expectedFiles: ["routes/boe.js"],
      createdBy: "p1",
      createdAt: 1,
      status: "pending-commit",
      proposedHunks: hunks,
      proposedFiles: ["routes/boe.js"],
    } as Todo);
    assert.ok(qt);
    assert.equal(qt!.status, "pending-commit");
    assert.deepEqual(qt!.proposedHunks, hunks);
  });
});

describe("restoreBoardFromSnapshot", () => {
  it("restores actionable todos including pending-commit", () => {
    const snap: BlackboardStateSnapshot = {
      contract: {
        missionStatement: "m",
        criteria: [],
        createdAt: 1,
      },
      board: {
        todos: [
          {
            id: "t1",
            description: "open",
            expectedFiles: ["a.js"],
            createdBy: "p",
            createdAt: 1,
            status: "open",
          },
          {
            id: "t2",
            description: "pending commit",
            expectedFiles: ["b.js"],
            createdBy: "p",
            createdAt: 2,
            status: "pending-commit",
            proposedHunks: [{ op: "append", file: "b.js", content: "z" }],
          },
        ] as Todo[],
        findings: [{ id: "f1", agentId: "a1", text: "note", createdAt: 3 }],
      },
      currentTier: 1,
      tiersCompleted: 0,
    };

    const todoQueue = new TodoQueue();
    const findings = new FindingsLog();
    const result = restoreBoardFromSnapshot({ snap, todoQueue, findings });

    assert.equal(result.restoredTodos, 2);
    assert.equal(result.pendingCommit, 1);
    assert.equal(result.pending, 1);
    assert.equal(result.findings, 1);
    assert.equal(countActionableTodos(snap.board!.todos), 2);
  });
});