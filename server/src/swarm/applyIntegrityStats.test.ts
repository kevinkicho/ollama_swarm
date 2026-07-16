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

  /**
   * Scenario matrix for ownership rules (review PR6 Issues 1–2):
   * - Preflight records repair + original miss only on accepted repair
   * - Real applyAndCommit owns attempts/applied/miss otherwise
   * - dryRunOnly must not increment counters (tested via absence of notes)
   */
  describe("ownership scenarios (no double-count)", () => {
    it("first apply ok → attempts=1 applied=1 miss empty", () => {
      startApplyIntegrityTracking("s1");
      noteApplyAttempt("s1");
      noteApplySuccess("s1");
      const snap = snapshotApplyIntegrityForRun("s1")!;
      assert.equal(snap.attempts, 1);
      assert.equal(snap.applied, 1);
      assert.deepEqual(snap.missByKind, {});
      assert.equal(snap.repairSuccesses, 0);
    });

    it("miss, repair ok, commit ok → miss once + repairSuccess + attempt/applied", () => {
      startApplyIntegrityTracking("s2");
      // Preflight accepted repair: note original miss once + repairSuccess
      noteApplyMiss("search_not_found", "s2");
      noteRepairSuccess("s2");
      // Real apply of repaired hunks
      noteApplyAttempt("s2");
      noteApplySuccess("s2");
      const snap = snapshotApplyIntegrityForRun("s2")!;
      assert.equal(snap.attempts, 1);
      assert.equal(snap.applied, 1);
      assert.deepEqual(snap.missByKind, { search_not_found: 1 });
      assert.equal(snap.repairSuccesses, 1);
      assert.equal(snap.repairFailures, 0);
    });

    it("miss, repair fail, real apply miss → missByKind=1 not 2", () => {
      startApplyIntegrityTracking("s3");
      // Preflight: repairFailure only — do NOT note miss (real path owns it)
      noteRepairFailure("s3");
      // Real apply of original hunks
      noteApplyAttempt("s3");
      noteApplyMiss("search_not_found", "s3");
      const snap = snapshotApplyIntegrityForRun("s3")!;
      assert.equal(snap.attempts, 1);
      assert.equal(snap.applied, 0);
      assert.deepEqual(snap.missByKind, { search_not_found: 1 });
      assert.equal(snap.repairFailures, 1);
      assert.equal(snap.repairSuccesses, 0);
    });

    it("preflightDryRun ok + auditor commit → attempts=1 applied=1 (not 2)", () => {
      startApplyIntegrityTracking("s4");
      // dryRunOnly path: no notes at all
      // Auditor real apply:
      noteApplyAttempt("s4");
      noteApplySuccess("s4");
      const snap = snapshotApplyIntegrityForRun("s4")!;
      assert.equal(snap.attempts, 1);
      assert.equal(snap.applied, 1);
    });
  });
});
