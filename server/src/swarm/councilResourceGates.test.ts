import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCouncilResourceCaps } from "./councilResourceGates.js";

describe("checkCouncilResourceCaps", () => {
  it("passes when no caps configured", () => {
    assert.equal(checkCouncilResourceCaps({}).stop, false);
  });

  it("trips wall-clock when elapsed >= cap", () => {
    const hit = checkCouncilResourceCaps({
      wallClockCapMs: 60_000,
      startedAt: 1_000,
      now: 61_000,
    });
    assert.equal(hit.stop, true);
    if (hit.stop) {
      assert.equal(hit.kind, "wall-clock");
      assert.match(hit.detail, /cap:wall-clock/);
    }
  });

  it("does not trip wall-clock before cap", () => {
    const hit = checkCouncilResourceCaps({
      wallClockCapMs: 60_000,
      startedAt: 1_000,
      now: 30_000,
    });
    assert.equal(hit.stop, false);
  });

  it("trips tokens when spent >= budget", () => {
    const hit = checkCouncilResourceCaps({
      tokenBudget: 1_000,
      tokenBaseline: 10_000,
      lifetimeTokens: 12_000, // spent 2000
    });
    assert.equal(hit.stop, true);
    if (hit.stop) {
      assert.equal(hit.kind, "tokens");
      assert.match(hit.detail, /cap:tokens/);
    }
  });

  it("does not trip tokens under budget", () => {
    const hit = checkCouncilResourceCaps({
      tokenBudget: 5_000,
      tokenBaseline: 10_000,
      lifetimeTokens: 12_000, // spent 2000
    });
    assert.equal(hit.stop, false);
  });
});
