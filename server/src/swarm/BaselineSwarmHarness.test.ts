// T-Item-1 (2026-05-04): unit tests for the parallel-clone baseline
// harness's pure scoring + winner-pick + cleanup-safety helpers.
// Integration test of the full K-attempts pipeline lives outside this
// file (would require simulating clone + git + Ollama).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  scoreBaselineResult,
  pickWinnerAttempt,
  isPathSafelyUnderParent,
} from "./BaselineSwarmHarness.js";
import type { BaselineResult } from "./BaselineRunner.js";

test("scoreBaselineResult — null result scores -1 (never wins)", () => {
  assert.equal(scoreBaselineResult(null), -1);
});

test("scoreBaselineResult — applied hunks contribute 1:1", () => {
  const r: BaselineResult = {
    hunksAttempted: 5,
    hunksApplied: 3,
    commitSha: "abc",
    verifyPassed: null,
  };
  assert.equal(scoreBaselineResult(r), 3);
});

test("scoreBaselineResult — verify pass adds +5", () => {
  const r: BaselineResult = {
    hunksAttempted: 2,
    hunksApplied: 2,
    commitSha: "abc",
    verifyPassed: true,
  };
  assert.equal(scoreBaselineResult(r), 7); // 2 + 5
});

test("scoreBaselineResult — verify fail subtracts -3", () => {
  const r: BaselineResult = {
    hunksAttempted: 2,
    hunksApplied: 2,
    commitSha: "abc",
    verifyPassed: false,
  };
  assert.equal(scoreBaselineResult(r), -1); // 2 - 3
});

test("scoreBaselineResult — verify-passed weighted higher than failed", () => {
  // A verify-passing 1-hunk attempt should beat a verify-failing 2-hunk
  // attempt: ensures the bonus signs make sense across the boundary.
  const passOneHunk: BaselineResult = {
    hunksAttempted: 1,
    hunksApplied: 1,
    commitSha: "a",
    verifyPassed: true,
  };
  const failTwoHunk: BaselineResult = {
    hunksAttempted: 2,
    hunksApplied: 2,
    commitSha: "b",
    verifyPassed: false,
  };
  assert.ok(
    scoreBaselineResult(passOneHunk) > scoreBaselineResult(failTwoHunk),
  );
});

test("pickWinnerAttempt — empty input returns null", () => {
  assert.equal(pickWinnerAttempt([]), null);
});

test("pickWinnerAttempt — picks highest score", () => {
  const attempts = [
    { attempt: 1, score: 2 },
    { attempt: 2, score: 7 },
    { attempt: 3, score: 4 },
  ];
  assert.equal(pickWinnerAttempt(attempts)?.attempt, 2);
});

test("pickWinnerAttempt — tie broken by lowest attempt#", () => {
  // Earlier-launched attempts win ties (deterministic; no race-induced
  // drift across runs).
  const attempts = [
    { attempt: 3, score: 5 },
    { attempt: 1, score: 5 },
    { attempt: 2, score: 5 },
  ];
  assert.equal(pickWinnerAttempt(attempts)?.attempt, 1);
});

test("pickWinnerAttempt — does not mutate input", () => {
  const attempts = [
    { attempt: 2, score: 1 },
    { attempt: 1, score: 9 },
  ];
  const before = JSON.stringify(attempts);
  pickWinnerAttempt(attempts);
  assert.equal(JSON.stringify(attempts), before);
});

test("isPathSafelyUnderParent — accepts proper subdir", () => {
  const parent = path.join("/tmp", "runs");
  const candidate = path.join(parent, "repo-attempt-1");
  assert.ok(isPathSafelyUnderParent(candidate, parent));
});

test("isPathSafelyUnderParent — rejects parent itself", () => {
  const parent = path.join("/tmp", "runs");
  assert.ok(!isPathSafelyUnderParent(parent, parent));
});

test("isPathSafelyUnderParent — rejects sibling-with-shared-prefix", () => {
  // /tmp/runs2/foo must not be considered "under" /tmp/runs even though
  // the string "/tmp/runs" is a prefix of "/tmp/runs2".
  const parent = path.join("/tmp", "runs");
  const sibling = path.join("/tmp", "runs2", "foo");
  assert.ok(!isPathSafelyUnderParent(sibling, parent));
});

test("isPathSafelyUnderParent — rejects unrelated path", () => {
  assert.ok(!isPathSafelyUnderParent("/etc/passwd", "/tmp/runs"));
});
