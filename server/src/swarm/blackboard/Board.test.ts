import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Board } from "./Board.js";
import type { BoardEvent } from "./types.js";

function makeBoard() {
  let idSeq = 0;
  const events: BoardEvent[] = [];
  const board = new Board({
    emit: (e) => events.push(e),
    genId: () => `id-${++idSeq}`,
  });
  return { board, events };
}

// Narrows a {ok: boolean} union to the success variant for subsequent asserts.
function expectOk<T extends { ok: boolean }>(r: T): asserts r is T & { ok: true } {
  if (!r.ok) assert.fail(`expected ok result, got ${JSON.stringify(r)}`);
}

describe("Board.postTodo", () => {
  it("creates an open todo and emits todo_posted", () => {
    const { board, events } = makeBoard();
    const todo = board.postTodo({
      description: "add readme badge",
      expectedFiles: ["README.md"],
      createdBy: "planner",
      createdAt: 100,
    });
    assert.equal(todo.id, "id-1");
    assert.equal(todo.status, "open");
    assert.equal(todo.replanCount, 0);
    assert.deepEqual(todo.expectedFiles, ["README.md"]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "todo_posted");
  });

  it("rejects empty description", () => {
    const { board } = makeBoard();
    assert.throws(() =>
      board.postTodo({ description: "   ", expectedFiles: [], createdBy: "p", createdAt: 0 }),
    );
  });

  it("lists todos in createdAt order", () => {
    const { board } = makeBoard();
    board.postTodo({ description: "a", expectedFiles: [], createdBy: "p", createdAt: 200 });
    board.postTodo({ description: "b", expectedFiles: [], createdBy: "p", createdAt: 100 });
    const list = board.listTodos();
    assert.equal(list[0]?.description, "b");
    assert.equal(list[1]?.description, "a");
  });

  it("persists criterionId when provided", () => {
    const { board, events } = makeBoard();
    const todo = board.postTodo({
      description: "address c1",
      expectedFiles: ["README.md"],
      createdBy: "planner",
      createdAt: 100,
      criterionId: "c1",
    });
    assert.equal(todo.criterionId, "c1");
    const fresh = board.listTodos()[0];
    assert.equal(fresh?.criterionId, "c1");
    const ev = events.at(-1);
    assert.equal(ev?.type, "todo_posted");
    if (ev?.type === "todo_posted") {
      assert.equal(ev.todo.criterionId, "c1");
    }
  });

  it("leaves criterionId undefined when omitted", () => {
    const { board } = makeBoard();
    const todo = board.postTodo({
      description: "plain todo",
      expectedFiles: [],
      createdBy: "planner",
      createdAt: 100,
    });
    assert.equal(todo.criterionId, undefined);
    const fresh = board.listTodos()[0];
    assert.equal(fresh?.criterionId, undefined);
  });
});

describe("Board.claimTodo", () => {
  it("claims an open todo", () => {
    const { board, events } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a.ts"],
      createdBy: "p",
      createdAt: 100,
    });
    const r = board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: { "a.ts": "hA" },
      claimedAt: 200,
      expiresAt: 800,
    });
    expectOk(r);
    assert.equal(r.todo.status, "claimed");
    assert.equal(r.todo.claim?.agentId, "a1");
    assert.equal(r.todo.claim?.fileHashes["a.ts"], "hA");
    assert.equal(events.at(-1)?.type, "todo_claimed");
  });

  it("rejects second claim on same todo (race)", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    const r1 = board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 800,
    });
    const r2 = board.claimTodo({
      todoId: t.id,
      agentId: "a2",
      fileHashes: {},
      claimedAt: 201,
      expiresAt: 801,
    });
    expectOk(r1);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.reason, "not_open");
  });

  it("returns not_found for missing todo", () => {
    const { board } = makeBoard();
    const r = board.claimTodo({
      todoId: "missing",
      agentId: "a1",
      fileHashes: {},
      claimedAt: 0,
      expiresAt: 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_found");
  });

  it("findOpenTodo skips claimed ones", () => {
    const { board } = makeBoard();
    const t1 = board.postTodo({
      description: "first",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    const t2 = board.postTodo({
      description: "second",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 101,
    });
    board.claimTodo({
      todoId: t1.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 800,
    });
    const next = board.findOpenTodo();
    assert.equal(next?.id, t2.id);
  });
});

describe("Board.commitTodo", () => {
  it("commits when all hashes match", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a.ts"],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: { "a.ts": "hA" },
      claimedAt: 200,
      expiresAt: 800,
    });
    const r = board.commitTodo({
      todoId: t.id,
      agentId: "a1",
      currentHashes: { "a.ts": "hA" },
      committedAt: 300,
    });
    expectOk(r);
    assert.equal(r.todo.status, "committed");
    assert.equal(r.todo.committedAt, 300);
  });

  it("returns stale with mismatch details when a hash differs", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a.ts"],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: { "a.ts": "hA" },
      claimedAt: 200,
      expiresAt: 800,
    });
    const r = board.commitTodo({
      todoId: t.id,
      agentId: "a1",
      currentHashes: { "a.ts": "hB" },
      committedAt: 300,
    });
    assert.equal(r.ok, false);
    if (!r.ok && r.reason === "stale") {
      assert.equal(r.mismatches.length, 1);
      assert.equal(r.mismatches[0]?.path, "a.ts");
      assert.equal(r.mismatches[0]?.expected, "hA");
      assert.equal(r.mismatches[0]?.actual, "hB");
    } else {
      assert.fail("expected stale result");
    }
  });

  it("rejects wrong agent", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 800,
    });
    const r = board.commitTodo({
      todoId: t.id,
      agentId: "a2",
      currentHashes: {},
      committedAt: 300,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "wrong_agent");
  });

  it("rejects commit on unclaimed todo", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    const r = board.commitTodo({
      todoId: t.id,
      agentId: "a1",
      currentHashes: {},
      committedAt: 300,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_claimed");
  });

  it("leaves todo in 'claimed' state on stale failure", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a"],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: { a: "A" },
      claimedAt: 200,
      expiresAt: 800,
    });
    board.commitTodo({
      todoId: t.id,
      agentId: "a1",
      currentHashes: { a: "B" },
      committedAt: 300,
    });
    const list = board.listTodos();
    assert.equal(list[0]?.status, "claimed");
  });
});

describe("Board.markStale", () => {
  it("reverts a claimed todo to stale and clears the claim", () => {
    const { board, events } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 800,
    });
    const r = board.markStale(t.id, "CAS failed");
    expectOk(r);
    assert.equal(r.todo.status, "stale");
    assert.equal(r.todo.staleReason, "CAS failed");
    assert.equal(r.todo.claim, undefined);
    assert.equal(events.at(-1)?.type, "todo_stale");
  });

  it("refuses to mark a committed todo stale", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 800,
    });
    board.commitTodo({
      todoId: t.id,
      agentId: "a1",
      currentHashes: {},
      committedAt: 300,
    });
    const r = board.markStale(t.id, "whatever");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_claimable");
  });
});

describe("Board.replan", () => {
  it("rewrites a stale todo and sets it back to open", () => {
    const { board, events } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a"],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: { a: "A" },
      claimedAt: 200,
      expiresAt: 800,
    });
    board.markStale(t.id, "whatever");
    const r = board.replan(t.id, { description: "y", expectedFiles: ["b", "c"] });
    expectOk(r);
    assert.equal(r.todo.status, "open");
    assert.equal(r.todo.description, "y");
    assert.deepEqual(r.todo.expectedFiles, ["b", "c"]);
    assert.equal(r.todo.replanCount, 1);
    assert.equal(r.todo.staleReason, undefined);
    assert.equal(events.at(-1)?.type, "todo_replanned");
  });

  it("rejects replan of a non-stale todo", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    const r = board.replan(t.id, { description: "y", expectedFiles: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_stale");
  });

  it("rejects replan of an unknown todo id", () => {
    const { board } = makeBoard();
    const r = board.replan("does-not-exist", { description: "y", expectedFiles: ["a"] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_found");
  });

  it("bumps replanCount across successive replans", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a"],
      createdBy: "p",
      createdAt: 100,
    });
    board.markStale(t.id, "first");
    const r1 = board.replan(t.id, { description: "y1", expectedFiles: ["a"] });
    expectOk(r1);
    assert.equal(r1.todo.replanCount, 1);
    board.markStale(t.id, "second");
    const r2 = board.replan(t.id, { description: "y2", expectedFiles: ["b"] });
    expectOk(r2);
    assert.equal(r2.todo.replanCount, 2);
  });

  it("rejects replan with empty description", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a"],
      createdBy: "p",
      createdAt: 100,
    });
    board.markStale(t.id, "why");
    assert.throws(() => board.replan(t.id, { description: "   ", expectedFiles: ["a"] }));
  });

  it("emits todo_replanned with the new description, expectedFiles, and count", () => {
    const { board, events } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a"],
      createdBy: "p",
      createdAt: 100,
    });
    board.markStale(t.id, "why");
    board.replan(t.id, { description: "new desc", expectedFiles: ["b", "c"] });
    const ev = events.at(-1);
    assert.equal(ev?.type, "todo_replanned");
    if (ev?.type === "todo_replanned") {
      assert.equal(ev.description, "new desc");
      assert.deepEqual(ev.expectedFiles, ["b", "c"]);
      assert.equal(ev.replanCount, 1);
    }
  });
});

describe("Board.skip", () => {
  it("marks a todo skipped", () => {
    const { board, events } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    const r = board.skip(t.id, "not worth doing");
    expectOk(r);
    assert.equal(r.todo.status, "skipped");
    assert.equal(r.todo.skippedReason, "not worth doing");
    assert.equal(events.at(-1)?.type, "todo_skipped");
  });
});

describe("Board.expireClaims", () => {
  it("marks expired claims as stale", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 500,
    });
    const expired = board.expireClaims(600);
    assert.deepEqual(expired, [t.id]);
    const list = board.listTodos();
    assert.equal(list[0]?.status, "stale");
    assert.equal(list[0]?.staleReason, "claim expired");
  });

  it("leaves non-expired claims alone", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    board.claimTodo({
      todoId: t.id,
      agentId: "a1",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 1000,
    });
    const expired = board.expireClaims(600);
    assert.equal(expired.length, 0);
    assert.equal(board.listTodos()[0]?.status, "claimed");
  });
});

describe("Board.postFinding", () => {
  it("stores and lists findings", () => {
    const { board, events } = makeBoard();
    const f = board.postFinding({
      agentId: "a1",
      text: "README mentions Bun but project uses node",
      createdAt: 100,
    });
    assert.equal(f.id, "id-1");
    const list = board.listFindings();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.text, f.text);
    assert.equal(events.at(-1)?.type, "finding_posted");
  });

  it("rejects empty finding text", () => {
    const { board } = makeBoard();
    assert.throws(() => board.postFinding({ agentId: "a", text: "   ", createdAt: 0 }));
  });
});

describe("Board.counts", () => {
  it("tracks all status transitions", () => {
    const { board } = makeBoard();
    const t1 = board.postTodo({
      description: "1",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 100,
    });
    const t2 = board.postTodo({
      description: "2",
      expectedFiles: [],
      createdBy: "p",
      createdAt: 101,
    });
    board.postTodo({ description: "3", expectedFiles: [], createdBy: "p", createdAt: 102 });
    board.claimTodo({
      todoId: t1.id,
      agentId: "a",
      fileHashes: {},
      claimedAt: 200,
      expiresAt: 800,
    });
    board.commitTodo({
      todoId: t1.id,
      agentId: "a",
      currentHashes: {},
      committedAt: 300,
    });
    board.skip(t2.id, "not needed");
    const c = board.counts();
    assert.equal(c.open, 1);
    assert.equal(c.claimed, 0);
    assert.equal(c.committed, 1);
    assert.equal(c.skipped, 1);
    assert.equal(c.total, 3);
  });
});

describe("Board defensive copying", () => {
  it("returned todos are independent of internal state", () => {
    const { board } = makeBoard();
    const t = board.postTodo({
      description: "x",
      expectedFiles: ["a"],
      createdBy: "p",
      createdAt: 100,
    });
    t.expectedFiles.push("mutation");
    t.description = "mutation";
    const fresh = board.listTodos()[0];
    assert.deepEqual(fresh?.expectedFiles, ["a"]);
    assert.equal(fresh?.description, "x");
  });
});
