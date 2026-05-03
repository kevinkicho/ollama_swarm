// 2026-05-03 (Phase B): unit tests for the budget-guard helper.
// The actual budget cap evaluation logic lives in ollamaProxy
// (tokenBudgetExceeded + shouldHaltOnQuota) which has its own tests;
// this module tests the message-formatting + halt-result shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBudgetGuards } from "./loopGuards.js";

describe("checkBudgetGuards", () => {
  it("returns halt=false when no budget set + no quota wall hit", () => {
    // tokenBudget undefined => tokenBudgetExceeded returns false.
    // No quota state set => shouldHaltOnQuota returns false (cleared per test).
    const result = checkBudgetGuards({
      tokenBaseline: Number.MAX_SAFE_INTEGER, // ensure tokens-since-baseline is 0
      tokenBudget: undefined,
      round: 1,
      totalRounds: 5,
      unit: "round",
    });
    assert.equal(result.halt, false);
    assert.equal(result.earlyStopDetail, undefined);
    assert.equal(result.message, undefined);
  });

  it("returns halt=false when budget is 0 (means no cap)", () => {
    const result = checkBudgetGuards({
      tokenBaseline: 0,
      tokenBudget: 0,
      round: 1,
      totalRounds: 5,
      unit: "round",
    });
    assert.equal(result.halt, false);
  });

  // Note: triggering halt=true requires either:
  //   - tokenTracker.lifetimeTokens > tokenBaseline + budget, or
  //   - tokenTracker.getQuotaState() returning a state object
  // Both are mutated through the proxy module's internal state which
  // these unit tests don't (and shouldn't) reach into. The integration
  // path is covered by each runner's per-loop test that actually
  // triggers a budget cap. What this test locks down is the shape of
  // the no-halt path so the runners' early-return is reliable.

  // The MESSAGE format is locked at the migration site by snapshot —
  // each runner's earlyStopDetail string is now sourced from this
  // helper. If a runner test breaks after Phase B because the message
  // text shifted, fix the helper, not the test.
});
