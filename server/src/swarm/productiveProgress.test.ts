import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProductiveCycle,
  isDurableProgress,
  isActiveCycle,
  durableMetFlips,
  updateZeroProgressStreak,
  formatNoProductiveProgressReason,
  DEFAULT_ZERO_PROGRESS_LIMIT,
  MAX_STRETCH_WAVES_PER_RUN,
} from "./productiveProgress.js";

describe("isDurableProgress / isProductiveCycle", () => {
  it("false when all zeros", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 0 }),
      false,
    );
  });
  it("true on durable met flips", () => {
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
  it("false on new todos alone (no audit/stretch spin)", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 3 }),
      false,
    );
    assert.equal(
      isDurableProgress({ metFlips: 0, commitsThisCycle: 0, newTodos: 3 }),
      false,
    );
  });
  it("false when all met flips are skip-only", () => {
    assert.equal(
      isProductiveCycle({
        metFlips: 2,
        commitsThisCycle: 0,
        newTodos: 0,
        skipOnlyMetFlips: 2,
      }),
      false,
    );
    assert.equal(
      durableMetFlips({ metFlips: 2, commitsThisCycle: 0, newTodos: 0, skipOnlyMetFlips: 2 }),
      0,
    );
  });
  it("true when some met flips are durable", () => {
    assert.equal(
      isProductiveCycle({
        metFlips: 3,
        commitsThisCycle: 0,
        newTodos: 0,
        skipOnlyMetFlips: 1,
      }),
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
  it("isActiveCycle true for new todos even when not durable", () => {
    assert.equal(
      isActiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 2 }),
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
  it("includes streak and durable wording", () => {
    assert.match(formatNoProductiveProgressReason(3), /3 cycle/);
    assert.match(formatNoProductiveProgressReason(3), /durable met flips|commits/i);
  });
});

describe("MAX_STRETCH_WAVES_PER_RUN", () => {
  it("is a small positive cap", () => {
    assert.ok(MAX_STRETCH_WAVES_PER_RUN >= 1 && MAX_STRETCH_WAVES_PER_RUN <= 3);
  });
});
