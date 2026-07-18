import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isHighFailCycle,
  updateHighFailStreak,
  shouldStopOnCumulativeFailRate,
  parseExecutionCompleteLine,
  formatHighFailCycleReason,
  HIGH_FAIL_CYCLE_STREAK_LIMIT,
} from "./executionHealthGuard.js";

describe("executionHealthGuard", () => {
  it("isHighFailCycle: zero done with 2+ fails", () => {
    assert.equal(isHighFailCycle({ done: 0, failed: 2 }), true);
    assert.equal(isHighFailCycle({ done: 0, failed: 1 }), false);
  });

  it("isHighFailCycle: rate ≥50% and failed ≥ done", () => {
    assert.equal(isHighFailCycle({ done: 1, failed: 4 }), true);
    assert.equal(isHighFailCycle({ done: 6, failed: 10 }), true);
    assert.equal(isHighFailCycle({ done: 5, failed: 4 }), false);
    assert.equal(isHighFailCycle({ done: 1, failed: 0 }), false);
  });

  it("updateHighFailStreak stops after limit", () => {
    let streak = 0;
    let stop = false;
    for (let i = 0; i < HIGH_FAIL_CYCLE_STREAK_LIMIT - 1; i++) {
      const r = updateHighFailStreak(streak, true);
      streak = r.streak;
      stop = r.shouldStop;
      assert.equal(stop, false);
    }
    const final = updateHighFailStreak(streak, true);
    assert.equal(final.shouldStop, true);
    assert.equal(final.streak, HIGH_FAIL_CYCLE_STREAK_LIMIT);
  });

  it("updateHighFailStreak resets on productive cycle", () => {
    const mid = updateHighFailStreak(2, true);
    assert.equal(mid.streak, 3);
    const reset = updateHighFailStreak(mid.streak, false);
    assert.equal(reset.streak, 0);
    assert.equal(reset.shouldStop, false);
  });

  it("shouldStopOnCumulativeFailRate matches 4de10651-shaped thrash", () => {
    // ~41 done / 69 failed from run 4de10651
    assert.equal(
      shouldStopOnCumulativeFailRate({ done: 41, failed: 69 }),
      true,
    );
    assert.equal(
      shouldStopOnCumulativeFailRate({ done: 20, failed: 10 }),
      false,
    );
    assert.equal(
      shouldStopOnCumulativeFailRate({ done: 5, failed: 6 }),
      false, // below min settled
    );
  });

  it("parseExecutionCompleteLine", () => {
    const c = parseExecutionCompleteLine(
      "[execution] Complete: 5 done, 4 failed, 0 skipped — cycle queue settled.",
    );
    assert.deepEqual(c, { done: 5, failed: 4, skipped: 0 });
    assert.equal(parseExecutionCompleteLine("unrelated"), null);
  });

  it("formatHighFailCycleReason is operator-readable", () => {
    assert.match(
      formatHighFailCycleReason(3, { done: 0, failed: 4 }),
      /execution-thrash|high-fail/i,
    );
  });
});
