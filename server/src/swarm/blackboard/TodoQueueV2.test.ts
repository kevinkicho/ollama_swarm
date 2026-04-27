// V2 Step 5a tests: TodoQueueV2 substrate semantics.
//
// Covers FIFO order, status transitions, retry bookkeeping, and the
// guards that prevent invalid state transitions (e.g., completing a
// pending todo). The git-based conflict-handling lives in the worker
// pipeline (Step 5b, future) — this file tests the queue alone.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TodoQueueV2 } from "./TodoQueueV2.js";

describe("TodoQueueV2 — basic FIFO semantics", () => {
  it("post + dequeue returns the oldest pending todo first", () => {
    const q = new TodoQueueV2();
    const id1 = q.post({ description: "first", expectedFiles: ["a.ts"], createdBy: "planner" });
    const id2 = q.post({ description: "second", expectedFiles: ["b.ts"], createdBy: "planner" });
    const id3 = q.post({ description: "third", expectedFiles: ["c.ts"], createdBy: "planner" });
    const t1 = q.dequeue("worker-2");
    const t2 = q.dequeue("worker-3");
    const t3 = q.dequeue("worker-2");
    assert.equal(t1?.id, id1);
    assert.equal(t2?.id, id2);
    assert.equal(t3?.id, id3);
  });

  it("dequeue returns null when no pending todos", () => {
    const q = new TodoQueueV2();
    assert.equal(q.dequeue("worker-2"), null);
    q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2");
    assert.equal(q.dequeue("worker-2"), null);
  });

  it("dequeue marks todo in-progress + stamps workerId + startedAt", () => {
    const q = new TodoQueueV2();
    q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    const t = q.dequeue("worker-7", 12345);
    assert.equal(t?.status, "in-progress");
    assert.equal(t?.workerId, "worker-7");
    assert.equal(t?.startedAt, 12345);
  });

  it("returned todos are defensive copies — mutating doesn't affect queue", () => {
    const q = new TodoQueueV2();
    q.post({ description: "x", expectedFiles: ["a.ts"], createdBy: "p" });
    const t = q.dequeue("worker-2");
    if (!t) throw new Error("dequeue returned null");
    (t.expectedFiles as string[]).push("hacked.ts");
    const internal = q.list()[0];
    assert.equal(internal.expectedFiles.length, 1);
    assert.equal(internal.expectedFiles[0], "a.ts");
  });

  it("ids are sequentially generated t1, t2, t3...", () => {
    const q = new TodoQueueV2();
    const a = q.post({ description: "a", expectedFiles: [], createdBy: "p" });
    const b = q.post({ description: "b", expectedFiles: [], createdBy: "p" });
    const c = q.post({ description: "c", expectedFiles: [], createdBy: "p" });
    assert.equal(a, "t1");
    assert.equal(b, "t2");
    assert.equal(c, "t3");
  });
});

describe("TodoQueueV2 — terminal transitions", () => {
  it("complete() transitions in-progress → completed + clears reason", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2");
    q.complete(id, 999);
    const t = q.get(id);
    assert.equal(t?.status, "completed");
    assert.equal(t?.endedAt, 999);
    assert.equal(t?.reason, undefined);
  });

  it("fail() transitions in-progress → failed + records reason + bumps retries", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2");
    q.fail(id, "git apply rejected", 999);
    const t = q.get(id);
    assert.equal(t?.status, "failed");
    assert.equal(t?.reason, "git apply rejected");
    assert.equal(q.getRetries(id), 1);
  });

  it("skip() transitions in-progress → skipped (distinct from failed)", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2");
    q.skip(id, "out of scope", 999);
    const t = q.get(id);
    assert.equal(t?.status, "skipped");
    assert.equal(t?.reason, "out of scope");
    assert.equal(q.getRetries(id), 0); // skips don't bump retries
  });

  it("complete throws if todo isn't in-progress", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    assert.throws(() => q.complete(id), /status=pending/);
    q.dequeue("worker-2");
    q.complete(id);
    assert.throws(() => q.complete(id), /status=completed/);
  });

  it("fail throws if todo isn't in-progress", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    assert.throws(() => q.fail(id, "x"), /status=pending/);
  });

  it("skip throws if todo isn't in-progress", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    assert.throws(() => q.skip(id, "x"), /status=pending/);
  });

  it("operations on unknown id throw", () => {
    const q = new TodoQueueV2();
    assert.throws(() => q.complete("nope"), /Unknown todo id/);
    assert.throws(() => q.fail("nope", "x"), /Unknown todo id/);
    assert.throws(() => q.skip("nope", "x"), /Unknown todo id/);
    assert.throws(() => q.reset("nope"), /Unknown todo id/);
    assert.throws(() => q.getRetries("nope"), /Unknown todo id/);
  });
});

describe("TodoQueueV2 — retry bookkeeping", () => {
  it("reset() returns failed → pending so dequeue picks it up again", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2");
    q.fail(id, "first failure");
    q.reset(id);
    assert.equal(q.get(id)?.status, "pending");
    const second = q.dequeue("worker-3");
    assert.equal(second?.id, id);
  });

  it("retries persist across reset cycles for caller's max-retries policy", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2"); q.fail(id, "fail 1"); q.reset(id);
    q.dequeue("worker-2"); q.fail(id, "fail 2"); q.reset(id);
    q.dequeue("worker-2"); q.fail(id, "fail 3");
    assert.equal(q.getRetries(id), 3);
  });

  it("reset throws if todo isn't in failed state", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    assert.throws(() => q.reset(id), /only failed allowed/);
    q.dequeue("worker-2");
    assert.throws(() => q.reset(id), /only failed allowed/);
    q.complete(id);
    assert.throws(() => q.reset(id), /only failed allowed/);
  });

  it("reset clears workerId, startedAt, endedAt, reason — fresh slate", () => {
    const q = new TodoQueueV2();
    const id = q.post({ description: "x", expectedFiles: [], createdBy: "p" });
    q.dequeue("worker-2", 100);
    q.fail(id, "first failure", 200);
    q.reset(id);
    const t = q.get(id);
    assert.equal(t?.workerId, undefined);
    assert.equal(t?.startedAt, undefined);
    assert.equal(t?.endedAt, undefined);
    assert.equal(t?.reason, undefined);
  });
});

describe("TodoQueueV2 — counts + list + clear", () => {
  it("counts() returns accurate per-status totals", () => {
    const q = new TodoQueueV2();
    const a = q.post({ description: "a", expectedFiles: [], createdBy: "p" });
    const b = q.post({ description: "b", expectedFiles: [], createdBy: "p" });
    const c = q.post({ description: "c", expectedFiles: [], createdBy: "p" });
    const d = q.post({ description: "d", expectedFiles: [], createdBy: "p" });
    q.dequeue("w"); q.complete(a);
    q.dequeue("w"); q.fail(b, "x");
    q.dequeue("w"); q.skip(c, "y");
    // d remains pending
    const counts = q.counts();
    assert.equal(counts.pending, 1);
    assert.equal(counts.inProgress, 0);
    assert.equal(counts.completed, 1);
    assert.equal(counts.failed, 1);
    assert.equal(counts.skipped, 1);
    assert.equal(counts.total, 4);
    void d; // silence unused
  });

  it("list() preserves insertion order", () => {
    const q = new TodoQueueV2();
    q.post({ description: "first", expectedFiles: [], createdBy: "p" });
    q.post({ description: "second", expectedFiles: [], createdBy: "p" });
    q.post({ description: "third", expectedFiles: [], createdBy: "p" });
    const order = q.list().map((t) => t.description);
    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("list() returns defensive copies — mutating doesn't affect queue", () => {
    const q = new TodoQueueV2();
    q.post({ description: "x", expectedFiles: ["a.ts"], createdBy: "p" });
    const snap = q.list();
    snap[0].description = "hacked";
    (snap[0].expectedFiles as string[]).push("evil.ts");
    const fresh = q.list()[0];
    assert.equal(fresh.description, "x");
    assert.equal(fresh.expectedFiles.length, 1);
  });

  it("clear() empties the queue + resets id counter", () => {
    const q = new TodoQueueV2();
    q.post({ description: "a", expectedFiles: [], createdBy: "p" });
    q.post({ description: "b", expectedFiles: [], createdBy: "p" });
    q.clear();
    assert.equal(q.counts().total, 0);
    const id = q.post({ description: "fresh", expectedFiles: [], createdBy: "p" });
    assert.equal(id, "t1");
  });
});

describe("TodoQueueV2 — mirror mode (syncStatus + postWithId)", () => {
  it("postWithId uses the supplied id verbatim", () => {
    const q = new TodoQueueV2();
    q.postWithId("v1-uuid-abc", { description: "x", expectedFiles: [], createdBy: "p" });
    assert.equal(q.get("v1-uuid-abc")?.id, "v1-uuid-abc");
    assert.equal(q.counts().pending, 1);
  });

  it("postWithId throws on id collision", () => {
    const q = new TodoQueueV2();
    q.postWithId("dup", { description: "x", expectedFiles: [], createdBy: "p" });
    assert.throws(
      () => q.postWithId("dup", { description: "y", expectedFiles: [], createdBy: "p" }),
      /collision/,
    );
  });

  it("syncStatus bypasses status guards (pending → completed direct)", () => {
    const q = new TodoQueueV2();
    q.postWithId("x", { description: "t", expectedFiles: [], createdBy: "p" });
    // Normal complete() would throw because status is pending. syncStatus skips the check.
    q.syncStatus("x", "completed", { ts: 999 });
    assert.equal(q.get("x")?.status, "completed");
    assert.equal(q.get("x")?.endedAt, 999);
  });

  it("syncStatus to in-progress stamps workerId + startedAt", () => {
    const q = new TodoQueueV2();
    q.postWithId("x", { description: "t", expectedFiles: [], createdBy: "p" });
    q.syncStatus("x", "in-progress", { workerId: "w-2", ts: 100 });
    assert.equal(q.get("x")?.status, "in-progress");
    assert.equal(q.get("x")?.workerId, "w-2");
    assert.equal(q.get("x")?.startedAt, 100);
  });

  it("syncStatus to failed bumps retries", () => {
    const q = new TodoQueueV2();
    q.postWithId("x", { description: "t", expectedFiles: [], createdBy: "p" });
    q.syncStatus("x", "failed", { reason: "x" });
    assert.equal(q.getRetries("x"), 1);
    q.syncStatus("x", "pending", {});
    q.syncStatus("x", "failed", { reason: "y" });
    assert.equal(q.getRetries("x"), 2);
  });

  it("syncStatus to pending clears worker/timing/reason fields", () => {
    const q = new TodoQueueV2();
    q.postWithId("x", { description: "t", expectedFiles: [], createdBy: "p" });
    q.syncStatus("x", "in-progress", { workerId: "w", ts: 100 });
    q.syncStatus("x", "failed", { reason: "boom", ts: 200 });
    q.syncStatus("x", "pending", {});
    const t = q.get("x");
    assert.equal(t?.workerId, undefined);
    assert.equal(t?.startedAt, undefined);
    assert.equal(t?.endedAt, undefined);
    assert.equal(t?.reason, undefined);
  });
});

describe("TodoQueueV2 — multi-worker concurrency model", () => {
  it("two workers dequeue different todos in FIFO order", () => {
    // The queue is the V2 model — workers don't claim files, they
    // just dequeue. Conflict handling (if two workers' hunks collide)
    // is handled by git apply downstream, not by the queue.
    const q = new TodoQueueV2();
    q.post({ description: "todo-A", expectedFiles: ["shared.ts"], createdBy: "p" });
    q.post({ description: "todo-B", expectedFiles: ["shared.ts"], createdBy: "p" });
    const w2 = q.dequeue("worker-2");
    const w3 = q.dequeue("worker-3");
    assert.equal(w2?.description, "todo-A");
    assert.equal(w3?.description, "todo-B");
    // Note: both workers got todos touching shared.ts — V2 allows this;
    // git will reject one of the two commits as a conflict and the
    // worker pipeline (Step 5b) will retry the loser.
  });

  it("third worker gets null when only 2 todos exist", () => {
    const q = new TodoQueueV2();
    q.post({ description: "a", expectedFiles: [], createdBy: "p" });
    q.post({ description: "b", expectedFiles: [], createdBy: "p" });
    q.dequeue("w-2");
    q.dequeue("w-3");
    assert.equal(q.dequeue("w-4"), null);
  });
});
