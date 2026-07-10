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
    assert.ok(r2.exhausted.includes(id));
    assert.equal(q.get(id)?.status, "failed");
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
