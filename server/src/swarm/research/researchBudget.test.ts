import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LITERATURE_BLACKOUT_AFTER,
  isResearchBlackout,
  noteCatalogInject,
  noteResearchAttempt,
  noteResearchFailure,
  noteResearchSuccess,
  snapshotResearchIntegrity,
  startResearchBudget,
} from "./researchBudget.js";

describe("researchBudget", () => {
  beforeEach(() => {
    startResearchBudget("test-run");
  });

  it("blackouts after consecutive failures", () => {
    for (let i = 0; i < LITERATURE_BLACKOUT_AFTER - 1; i++) {
      noteResearchAttempt("test-run");
      const r = noteResearchFailure("fail", "test-run");
      assert.equal(r.blackoutJustActivated, false);
      assert.equal(isResearchBlackout("test-run"), false);
    }
    noteResearchAttempt("test-run");
    const r = noteResearchFailure("fail final", "test-run");
    assert.equal(r.blackoutJustActivated, true);
    assert.equal(isResearchBlackout("test-run"), true);
  });

  it("resets consecutive failures on success", () => {
    noteResearchFailure("a", "test-run");
    noteResearchSuccess("test-run");
    assert.equal(isResearchBlackout("test-run"), false);
    const snap = snapshotResearchIntegrity("test-run");
    assert.ok(snap);
    assert.equal(snap!.usableBriefs, 1);
  });

  it("snapshots catalog injects", () => {
    noteCatalogInject("test-run");
    const snap = snapshotResearchIntegrity("test-run");
    assert.equal(snap?.catalogInjects, 1);
  });
});
