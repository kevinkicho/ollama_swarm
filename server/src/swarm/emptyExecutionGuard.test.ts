import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_EXECUTION_LIMIT,
  formatEmptyExecutionReason,
  updateEmptyExecutionStreak,
} from "./emptyExecutionGuard.js";

describe("emptyExecutionGuard", () => {
  it("resets streak on non-empty", () => {
    assert.deepEqual(updateEmptyExecutionStreak(2, false), {
      streak: 0,
      shouldAct: false,
    });
  });

  it("fires at limit", () => {
    let streak = 0;
    for (let i = 0; i < EMPTY_EXECUTION_LIMIT - 1; i++) {
      const r = updateEmptyExecutionStreak(streak, true);
      streak = r.streak;
      assert.equal(r.shouldAct, false);
    }
    const r = updateEmptyExecutionStreak(streak, true);
    assert.equal(r.streak, EMPTY_EXECUTION_LIMIT);
    assert.equal(r.shouldAct, true);
    assert.match(formatEmptyExecutionReason(r.streak), /empty-execution/);
  });
});
