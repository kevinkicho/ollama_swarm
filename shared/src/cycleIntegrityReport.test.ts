import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCycleFailReason,
  createCycleIntegrityCounters,
  noteCycleFail,
  noteEmptyExecutionCycle,
  noteNonEmptyExecutionCycle,
  snapshotCycleIntegrity,
} from "./cycleIntegrityReport.js";

describe("cycleIntegrityReport", () => {
  it("snapshots undefined when empty", () => {
    assert.equal(snapshotCycleIntegrity(createCycleIntegrityCounters()), undefined);
  });

  it("classifies apply vs json vs tool_loop", () => {
    assert.equal(classifyCycleFailReason("search text not found"), "apply_miss");
    assert.equal(classifyCycleFailReason("JSON parse failed"), "json_parse");
    assert.equal(classifyCycleFailReason("tool loop stuck: research"), "tool_loop");
    assert.equal(
      classifyCycleFailReason('create on existing file "src/x.js" — use op "write"'),
      "schema",
    );
    assert.equal(
      classifyCycleFailReason("endExclusive text not found after start"),
      "apply_miss",
    );
  });

  it("tracks empty execution streak", () => {
    const c = createCycleIntegrityCounters();
    noteEmptyExecutionCycle(c);
    noteEmptyExecutionCycle(c);
    assert.equal(c.lastEmptyStreak, 2);
    assert.equal(c.maxEmptyStreak, 2);
    noteNonEmptyExecutionCycle(c);
    assert.equal(c.lastEmptyStreak, 0);
    assert.equal(c.maxEmptyStreak, 2);
    const snap = snapshotCycleIntegrity(c);
    assert.ok(snap);
    assert.equal(snap!.emptyExecutionCycles, 2);
    assert.equal(snap!.failByBucket.empty_plan, 2);
  });

  it("notes fail buckets", () => {
    const c = createCycleIntegrityCounters();
    noteCycleFail(c, "apply_miss");
    noteCycleFail(c, "apply_miss");
    noteCycleFail(c, "json_parse");
    const snap = snapshotCycleIntegrity(c)!;
    assert.equal(snap.failByBucket.apply_miss, 2);
    assert.equal(snap.failByBucket.json_parse, 1);
    assert.equal(snap.todosFailed, 3);
  });
});
