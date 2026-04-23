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

// Unit 45: per-file claim lock — kills the row-by-row thrash where
// two workers parallel-claim todos that touch the same big file and
// only one commit can survive CAS. New behavior: claimTodo refuses
// when a sibling claim already holds an overlapping file, and a new
// findClaimableTodo helper pre-filters open todos by lock state so
// the worker dispatcher doesn't spin on a locked-but-still-open todo.
describe("Board file-lock (Unit 45)", () => {
  function postPair(board: Board, files1: string[], files2: string[]) {
    const t1 = board.postTodo({
      description: "edit row 1",
      expectedFiles: files1,
      createdBy: "planner",
      createdAt: 100,
    });
    const t2 = board.postTodo({
      description: "edit row 2",
      expectedFiles: files2,
      createdBy: "planner",
      createdAt: 101,
    });
    return { t1, t2 };
  }

  it("rejects claimTodo with file_locked when another claim covers an overlapping file", () => {
    const { board } = makeBoard();
    const { t1, t2 } = postPair(board, ["table.md"], ["table.md"]);
    const c1 = board.claimTodo({
      todoId: t1.id,
      agentId: "agent-A",
      fileHashes: { "table.md": "h1" },
      claimedAt: 200,
      expiresAt: 200_000,
    });
    expectOk(c1);
    const c2 = board.claimTodo({
      todoId: t2.id,
      agentId: "agent-B",
      fileHashes: { "table.md": "h1" },
      claimedAt: 201,
      expiresAt: 200_001,
    });
    assert.equal(c2.ok, false);
    if (c2.ok) return;
    assert.equal(c2.reason, "file_locked");
    if (c2.reason !== "file_locked") return;
    assert.deepEqual(c2.lockedFiles, ["table.md"]);
  });

  it("permits parallel claims on disjoint files", () => {
    const { board } = makeBoard();
    const { t1, t2 } = postPair(board, ["a.md"], ["b.md"]);
    const c1 = board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "a.md": "h" }, claimedAt: 1, expiresAt: 1000,
    });
    const c2 = board.claimTodo({
      todoId: t2.id, agentId: "B", fileHashes: { "b.md": "h" }, claimedAt: 2, expiresAt: 1001,
    });
    expectOk(c1);
    expectOk(c2);
  });

  it("releases the lock after commit so a queued sibling todo can claim", () => {
    const { board } = makeBoard();
    const { t1, t2 } = postPair(board, ["table.md"], ["table.md"]);
    board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "table.md": "h1" }, claimedAt: 1, expiresAt: 1000,
    });
    board.commitTodo({
      todoId: t1.id, agentId: "A", currentHashes: { "table.md": "h1" }, committedAt: 2,
    });
    // First claim is now committed → lock released → second claim succeeds.
    const c2 = board.claimTodo({
      todoId: t2.id, agentId: "B", fileHashes: { "table.md": "h2" }, claimedAt: 3, expiresAt: 1001,
    });
    expectOk(c2);
  });

  it("releases the lock on stale (claim cleared) so a fresh worker can claim", () => {
    const { board } = makeBoard();
    const { t1, t2 } = postPair(board, ["table.md"], ["table.md"]);
    board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "table.md": "h1" }, claimedAt: 1, expiresAt: 1000,
    });
    // Mark t1 stale (e.g. CAS rejected at commit). The Board clears
    // t1.claim, so t1's file is no longer locked even though t1 itself
    // is now in status "stale".
    board.markStale(t1.id, "CAS rejected");
    const c2 = board.claimTodo({
      todoId: t2.id, agentId: "B", fileHashes: { "table.md": "h2" }, claimedAt: 3, expiresAt: 1001,
    });
    expectOk(c2);
  });

  it("treats partial overlap as locked (any overlapping file blocks)", () => {
    const { board } = makeBoard();
    const { t1, t2 } = postPair(board, ["a.md", "b.md"], ["b.md", "c.md"]);
    board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "a.md": "h", "b.md": "h" }, claimedAt: 1, expiresAt: 1000,
    });
    const c2 = board.claimTodo({
      todoId: t2.id, agentId: "B", fileHashes: { "b.md": "h", "c.md": "h" }, claimedAt: 2, expiresAt: 1001,
    });
    assert.equal(c2.ok, false);
    if (c2.ok) return;
    assert.equal(c2.reason, "file_locked");
    if (c2.reason !== "file_locked") return;
    assert.deepEqual(c2.lockedFiles, ["b.md"]);
  });
});

describe("Board.findClaimableTodo (Unit 45)", () => {
  it("returns the same todo as findOpenTodo when nothing is locked", () => {
    const { board } = makeBoard();
    board.postTodo({ description: "x", expectedFiles: ["a"], createdBy: "p", createdAt: 1 });
    board.postTodo({ description: "y", expectedFiles: ["b"], createdBy: "p", createdAt: 2 });
    const open = board.findOpenTodo();
    const claimable = board.findClaimableTodo();
    assert.equal(open?.id, claimable?.id);
  });

  it("skips a locked todo and returns the next compatible one", () => {
    const { board } = makeBoard();
    const t1 = board.postTodo({ description: "t1", expectedFiles: ["table.md"], createdBy: "p", createdAt: 1 });
    board.postTodo({ description: "t2", expectedFiles: ["table.md"], createdBy: "p", createdAt: 2 });
    const t3 = board.postTodo({ description: "t3", expectedFiles: ["other.md"], createdBy: "p", createdAt: 3 });
    board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "table.md": "h" }, claimedAt: 10, expiresAt: 10_000,
    });
    // t2 is open but file-locked behind t1; t3 is open and free.
    // Expect findClaimableTodo to skip t2 and return t3.
    const next = board.findClaimableTodo();
    assert.equal(next?.id, t3.id);
  });

  it("returns undefined when every open todo is file-locked", () => {
    const { board } = makeBoard();
    const t1 = board.postTodo({ description: "t1", expectedFiles: ["a"], createdBy: "p", createdAt: 1 });
    board.postTodo({ description: "t2", expectedFiles: ["a"], createdBy: "p", createdAt: 2 });
    board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "a": "h" }, claimedAt: 10, expiresAt: 10_000,
    });
    assert.equal(board.findClaimableTodo(), undefined);
  });

  it("ignores claims on stale/committed/skipped todos when computing locks", () => {
    const { board } = makeBoard();
    const t1 = board.postTodo({ description: "t1", expectedFiles: ["a"], createdBy: "p", createdAt: 1 });
    const t2 = board.postTodo({ description: "t2", expectedFiles: ["a"], createdBy: "p", createdAt: 2 });
    board.claimTodo({
      todoId: t1.id, agentId: "A", fileHashes: { "a": "h" }, claimedAt: 10, expiresAt: 10_000,
    });
    board.commitTodo({
      todoId: t1.id, agentId: "A", currentHashes: { "a": "h" }, committedAt: 11,
    });
    // t1 is committed (no live claim) → t2 should be claimable.
    assert.equal(board.findClaimableTodo()?.id, t2.id);
  });
});
