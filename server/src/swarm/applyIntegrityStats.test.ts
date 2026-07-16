import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearApplyIntegrityTracking,
  noteApplyAttempt,
  noteApplyMiss,
  noteApplySuccess,
  noteRepairFailure,
  noteRepairSuccess,
  snapshotApplyIntegrityForRun,
  startApplyIntegrityTracking,
} from "./applyIntegrityStats.js";

describe("applyIntegrityStats registry", () => {
  beforeEach(() => {
    clearApplyIntegrityTracking();
  });

  it("tracks counters per runId and snapshots missByKind", () => {
    startApplyIntegrityTracking("run-a");
    noteApplyAttempt("run-a");
    noteApplyMiss("search_not_found", "run-a");
    noteApplyAttempt("run-a");
    noteApplySuccess("run-a");
    noteRepairSuccess("run-a");
    noteRepairFailure("run-a");

    const snap = snapshotApplyIntegrityForRun("run-a");
    assert.ok(snap);
    assert.equal(snap!.attempts, 2);
    assert.equal(snap!.applied, 1);
    assert.deepEqual(snap!.missByKind, { search_not_found: 1 });
    assert.equal(snap!.repairSuccesses, 1);
    assert.equal(snap!.repairFailures, 1);
  });

  it("returns undefined when no apply activity", () => {
    startApplyIntegrityTracking("run-empty");
    assert.equal(snapshotApplyIntegrityForRun("run-empty"), undefined);
  });
});
