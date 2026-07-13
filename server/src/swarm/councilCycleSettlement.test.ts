import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TodoQueue } from "./blackboard/TodoQueue.js";
import {
  createSettlementBook,
  isPermanentSkipReason,
  maxAttemptsForCycle,
  recordSettlementAttempt,
  requeueUnresolvedCouncilTodos,
} from "./councilCycleSettlement.js";

describe("councilCycleSettlement", () => {
  it("isPermanentSkipReason detects already-done skips", () => {
    assert.equal(
      isPermanentSkipReason("All four entries are already present in data/x.json. No changes needed."),
      true,
    );
    assert.equal(isPermanentSkipReason("search text not found in file"), false);
    assert.equal(isPermanentSkipReason("out of scope for this worker"), true);
    assert.equal(isPermanentSkipReason("permanent:noop-exhausted: wrote zero files"), true);
  });

  it("promotes repeated no-op fails to permanent skip", () => {
    const q = new TodoQueue();
    const id = q.post({
      description: "noop",
      expectedFiles: ["a.ts"],
      createdBy: "test",
    });
    const book = createSettlementBook();
    for (const worker of ["agent-2", "agent-3", "agent-4"]) {
      q.dequeue(worker);
      q.fail(id, "apply wrote zero files (no-op) — not a successful commit");
      recordSettlementAttempt(
        book,
        id,
        worker,
        "apply wrote zero files (no-op) — not a successful commit",
      );
    }
    const r = requeueUnresolvedCouncilTodos(q, ["agent-2", "agent-3", "agent-4"], book, {
      maxAttempts: 5,
    });
    assert.ok(r.permanentSkipped.includes(id));
    assert.equal(q.get(id)?.status, "skipped");
    assert.match(q.get(id)?.reason ?? "", /permanent:noop-exhausted/);
  });

  it("maxAttemptsForCycle is at least 2 and scales with agents", () => {
    assert.equal(maxAttemptsForCycle(1), 2);
    assert.equal(maxAttemptsForCycle(2), 2);
    assert.equal(maxAttemptsForCycle(3), 3);
  });

  it("requeues failed todos until max attempts, then exhausts", () => {
    const q = new TodoQueue();
    const id = q.post({
      description: "fix foo",
      expectedFiles: ["a.ts"],
      createdBy: "test",
    });
    q.dequeue("agent-2");
    q.fail(id, "hunk not found");
    const book = createSettlementBook();
    recordSettlementAttempt(book, id, "agent-2");

    const r1 = requeueUnresolvedCouncilTodos(q, ["agent-2", "agent-3"], book, {
      maxAttempts: 2,
    });
    assert.equal(r1.requeued, 1);
    assert.equal(q.get(id)?.status, "pending");

    q.dequeue("agent-3");
    q.fail(id, "hunk not found again");
    recordSettlementAttempt(book, id, "agent-3");

    const r2 = requeueUnresolvedCouncilTodos(q, ["agent-2", "agent-3"], book, {
      maxAttempts: 2,
    });
    assert.equal(r2.requeued, 0);
    // Exhausted attempts → permanent skip so the cycle can settle.
    assert.ok(r2.permanentSkipped.includes(id) || r2.exhausted.includes(id));
    const final = q.get(id);
    assert.ok(final?.status === "skipped" || final?.status === "failed");
    if (final?.status === "skipped") {
      assert.match(final.reason ?? "", /permanent:attempts-exhausted/);
    }
  });

  it("does not requeue permanent skips", () => {
    const q = new TodoQueue();
    const id = q.post({
      description: "add entry",
      expectedFiles: ["db.json"],
      createdBy: "test",
    });
    q.dequeue("agent-2");
    q.skip(id, "already present in db.json — no changes needed");
    const book = createSettlementBook();
    recordSettlementAttempt(book, id, "agent-2");
    const r = requeueUnresolvedCouncilTodos(q, ["agent-2"], book, { maxAttempts: 3 });
    assert.equal(r.requeued, 0);
    assert.equal(q.get(id)?.status, "skipped");
  });

  it("requeues soft skips for another agent", () => {
    const q = new TodoQueue();
    const id = q.post({
      description: "rewrite section",
      expectedFiles: ["doc.md"],
      createdBy: "test",
    });
    q.dequeue("agent-2");
    q.skip(id, "could not find unique search anchor");
    const book = createSettlementBook();
    recordSettlementAttempt(book, id, "agent-2");
    const r = requeueUnresolvedCouncilTodos(q, ["agent-2", "agent-3"], book, {
      maxAttempts: 2,
    });
    assert.equal(r.requeued, 1);
    assert.equal(q.get(id)?.status, "pending");
  });
});
