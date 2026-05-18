import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBudgetGuards } from "./loopGuards.js";

describe("checkBudgetGuards", () => {
  it("returns halt=false when no budget set + no quota wall hit", () => {
    const r = checkBudgetGuards({ tokenBaseline: 1e9, tokenBudget: undefined, round: 1, totalRounds: 5, unit: "round" });
    assert.equal(r.halt, false);
    assert.equal(r.earlyStopDetail, undefined);
    assert.equal(r.message, undefined);
  });

  it("returns halt=false when budget is 0", () => {
    const r = checkBudgetGuards({ tokenBaseline: 0, tokenBudget: 0, round: 1, totalRounds: 5, unit: "round" });
    assert.equal(r.halt, false);
  });

  it("handles cycle unit", () => {
    const r = checkBudgetGuards({ tokenBaseline: 1e9, tokenBudget: undefined, round: 3, totalRounds: 6, unit: "cycle" });
    assert.equal(r.halt, false);
  });

  it("handles round=0", () => {
    const r = checkBudgetGuards({ tokenBaseline: 1e9, tokenBudget: undefined, round: 0, totalRounds: 5, unit: "round" });
    assert.equal(r.halt, false);
  });

  it("handles totalRounds=0", () => {
    const r = checkBudgetGuards({ tokenBaseline: 1e9, tokenBudget: undefined, round: 1, totalRounds: 0, unit: "round" });
    assert.equal(r.halt, false);
  });

  it("handles round > totalRounds", () => {
    const r = checkBudgetGuards({ tokenBaseline: 1e9, tokenBudget: undefined, round: 10, totalRounds: 3, unit: "cycle" });
    assert.equal(r.halt, false);
  });

  it("handles large tokenBudget", () => {
    const r = checkBudgetGuards({ tokenBaseline: 1e9, tokenBudget: 1e12, round: 5, totalRounds: 10, unit: "round" });
    assert.equal(r.halt, false);
  });
});
