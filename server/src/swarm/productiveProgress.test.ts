import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProductiveCycle,
  updateZeroProgressStreak,
  formatNoProductiveProgressReason,
  DEFAULT_ZERO_PROGRESS_LIMIT,
} from "./productiveProgress.js";

describe("isProductiveCycle", () => {
  it("false when all zeros", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 0 }),
      false,
    );
  });
  it("true on met flips", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 1, commitsThisCycle: 0, newTodos: 0 }),
      true,
    );
  });
  it("true on commits", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 2, newTodos: 0 }),
      true,
    );
  });
  it("true on new todos", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 3 }),
      true,
    );
  });
  it("true on tier promotion", () => {
    assert.equal(
      isProductiveCycle({
        metFlips: 0,
        commitsThisCycle: 0,
        newTodos: 0,
        tierPromoted: true,
      }),
      true,
    );
  });
});

describe("updateZeroProgressStreak", () => {
  it("resets on productive", () => {
    assert.deepEqual(updateZeroProgressStreak(2, true), {
      streak: 0,
      shouldStop: false,
    });
  });
  it("stops at default limit", () => {
    const r = updateZeroProgressStreak(DEFAULT_ZERO_PROGRESS_LIMIT - 1, false);
    assert.equal(r.streak, DEFAULT_ZERO_PROGRESS_LIMIT);
    assert.equal(r.shouldStop, true);
  });
  it("does not stop below limit", () => {
    const r = updateZeroProgressStreak(0, false);
    assert.equal(r.streak, 1);
    assert.equal(r.shouldStop, false);
  });
});

describe("formatNoProductiveProgressReason", () => {
  it("includes streak", () => {
    assert.match(formatNoProductiveProgressReason(3), /3 cycle/);
  });
});
