import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyThinkGuardRefereePatch,
  formatThinkGuardRefereeChanges,
  patchHasThinkGuardReferee,
  resolveThinkGuardRefereeBudget,
} from "./thinkGuardBudget.js";

describe("resolveThinkGuardRefereeBudget", () => {
  it("applies defaults when fields absent", () => {
    const b = resolveThinkGuardRefereeBudget({}, false);
    assert.equal(b.enabled, false);
    assert.equal(b.maxCallsPerRun, 6);
    assert.equal(b.callsUsed, 0);
    assert.equal(b.callsRemaining, 6);
    assert.equal(b.minThinkCharsForReferee, 30_000);
    assert.equal(b.thinkTailMinChars, 4_000);
    assert.equal(b.thinkTailMaxChars, 12_000);
    assert.equal(b.maxOutputTokens, 512);
  });

  it("honors env enabled flag", () => {
    const b = resolveThinkGuardRefereeBudget({}, true);
    assert.equal(b.enabled, true);
  });

  it("computes calls remaining", () => {
    const b = resolveThinkGuardRefereeBudget({
      thinkGuardRefereeMaxCallsPerRun: 4,
      thinkGuardRefereeCallsUsed: 3,
    });
    assert.equal(b.callsRemaining, 1);
  });

  it("clamps tail max to min when inverted", () => {
    const b = resolveThinkGuardRefereeBudget({
      thinkGuardRefereeThinkTailMinChars: 10_000,
      thinkGuardRefereeThinkTailMaxChars: 5_000,
    });
    assert.equal(b.thinkTailMaxChars, 10_000);
  });
});

describe("applyThinkGuardRefereePatch", () => {
  it("patches referee fields", () => {
    const cfg: { thinkGuardRefereeEnabled?: boolean; thinkGuardRefereeMaxCallsPerRun?: number } = {
      thinkGuardRefereeMaxCallsPerRun: 6,
    };
    const r = applyThinkGuardRefereePatch(cfg, {
      thinkGuardRefereeEnabled: true,
      thinkGuardRefereeMaxCallsPerRun: 10,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(cfg.thinkGuardRefereeEnabled, true);
    assert.equal(cfg.thinkGuardRefereeMaxCallsPerRun, 10);
    assert.equal(r.changes.thinkGuardRefereeMaxCallsPerRun?.to, 10);
  });

  it("rejects out-of-range max calls", () => {
    const r = applyThinkGuardRefereePatch({}, { thinkGuardRefereeMaxCallsPerRun: 99 });
    assert.equal(r.ok, false);
  });
});

describe("patchHasThinkGuardReferee", () => {
  it("detects referee patch keys", () => {
    assert.equal(patchHasThinkGuardReferee({ thinkGuardRefereeEnabled: true }), true);
    assert.equal(patchHasThinkGuardReferee({ rounds: 5 } as never), false);
  });
});

describe("formatThinkGuardRefereeChanges", () => {
  it("formats mixed changes", () => {
    const parts = formatThinkGuardRefereeChanges({
      thinkGuardRefereeEnabled: { from: false, to: true },
      thinkGuardRefereeMaxCallsPerRun: { from: 6, to: 10 },
    });
    assert.ok(parts.some((p) => p.includes("referee false → on") || p.includes("referee off → on")));
    assert.ok(parts.some((p) => p.includes("referee calls")));
  });
});