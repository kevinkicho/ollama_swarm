import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createApplyIntegrityCounters,
  recordApplyAttempt,
  recordApplyMiss,
  recordApplySuccess,
  recordMissRecoveredDet,
  recordMissRecoveredLlm,
  recordMissTerminal,
  recordRepairFailure,
  recordRepairSuccess,
  snapshotApplyIntegrity,
} from "./applyIntegrityReport.js";

describe("applyIntegrityReport", () => {
  it("snapshot returns undefined for empty counters", () => {
    assert.equal(snapshotApplyIntegrity(createApplyIntegrityCounters()), undefined);
    assert.equal(snapshotApplyIntegrity(undefined), undefined);
    assert.equal(snapshotApplyIntegrity(null), undefined);
  });

  it("assembles summary-shaped report with missByKind", () => {
    const c = createApplyIntegrityCounters();
    recordApplyAttempt(c);
    recordApplyMiss(c, "search_not_found");
    recordApplyAttempt(c);
    recordApplyMiss(c, "start_not_unique");
    recordApplyAttempt(c);
    recordApplyMiss(c, "search_not_found");
    recordApplyAttempt(c);
    recordApplySuccess(c);
    recordRepairSuccess(c);
    recordRepairFailure(c);

    const snap = snapshotApplyIntegrity(c);
    assert.ok(snap);
    assert.equal(snap!.attempts, 4);
    assert.equal(snap!.applied, 1);
    assert.deepEqual(snap!.missByKind, {
      search_not_found: 2,
      start_not_unique: 1,
    });
    assert.equal(snap!.repairSuccesses, 1);
    assert.equal(snap!.repairFailures, 1);

    // JSON roundtrip (summary.json shape)
    const parsed = JSON.parse(JSON.stringify({ applyIntegrity: snap }));
    assert.deepEqual(parsed.applyIntegrity.missByKind, {
      search_not_found: 2,
      start_not_unique: 1,
    });
  });

  it("blank miss kind buckets as other", () => {
    const c = createApplyIntegrityCounters();
    recordApplyMiss(c, "  ");
    const snap = snapshotApplyIntegrity(c);
    assert.ok(snap);
    assert.equal(snap!.missByKind.other, 1);
  });

  it("tracks recovered vs terminal misses separately from missByKind", () => {
    const c = createApplyIntegrityCounters();
    recordApplyAttempt(c);
    recordApplyMiss(c, "search_not_found");
    recordMissRecoveredDet(c);
    recordApplySuccess(c);
    recordApplyAttempt(c);
    recordApplyMiss(c, "search_not_found");
    recordMissTerminal(c);
    const snap = snapshotApplyIntegrity(c);
    assert.ok(snap);
    assert.equal(snap!.missRecoveredDet, 1);
    assert.equal(snap!.missTerminal, 1);
    assert.equal(snap!.missByKind.search_not_found, 2);
    // Delivery still 1 applied of 2 attempts — recovered is not terminal fail.
    assert.equal(snap!.applied, 1);
  });
});
