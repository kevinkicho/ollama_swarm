// R16 (2026-05-04): tests for per-run health score.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRunHealthScore } from "./runHealthScore.js";
import type { RunHealthInput } from "./runHealthScore.js";

function input(overrides: Partial<RunHealthInput> = {}): RunHealthInput {
  return {
    commitsLanded: 0,
    tier: 0,
    totalTurns: 10,
    emptyTurns: 0,
    retryCount: 0,
    durationMs: 60_000,
    wallClockCapMs: 600_000,
    commitsCap: 0,
    errorCount: 0,
    ...overrides,
  };
}

test("computeRunHealthScore — perfect run → green", () => {
  const got = computeRunHealthScore(
    input({ commitsLanded: 5, tier: 3, totalTurns: 10 }),
  );
  assert.equal(got.bucket, "green");
  assert.ok(got.score >= 90);
});

test("computeRunHealthScore — neutral baseline (nothing happened) → yellow", () => {
  const got = computeRunHealthScore(input());
  assert.equal(got.bucket, "yellow");
  assert.equal(got.score, 60); // exact neutral
});

test("computeRunHealthScore — many errors → red", () => {
  const got = computeRunHealthScore(input({ errorCount: 20 }));
  assert.equal(got.bucket, "red");
});

test("computeRunHealthScore — high empty-turn rate → red", () => {
  const got = computeRunHealthScore(
    input({ totalTurns: 10, emptyTurns: 8 }),
  );
  assert.equal(got.bucket, "red");
});

test("computeRunHealthScore — many retries → red", () => {
  const got = computeRunHealthScore(input({ retryCount: 30 }));
  // Penalty caps at -20, score = 60 - 20 = 40 → red
  assert.equal(got.bucket, "red");
});

test("computeRunHealthScore — some commits but high errors → still yellow", () => {
  const got = computeRunHealthScore(
    input({ commitsLanded: 2, tier: 1, errorCount: 5 }),
  );
  assert.equal(got.bucket, "yellow");
});

test("computeRunHealthScore — score is clamped to [0, 100]", () => {
  const huge = computeRunHealthScore(
    input({ commitsLanded: 100, tier: 99 }),
  );
  assert.ok(huge.score <= 100);
  const tiny = computeRunHealthScore(
    input({
      errorCount: 50,
      retryCount: 50,
      totalTurns: 10,
      emptyTurns: 10,
    }),
  );
  assert.ok(tiny.score >= 0);
});

test("computeRunHealthScore — near wall-clock cap drags score down", () => {
  const ok = computeRunHealthScore(
    input({ commitsLanded: 3, tier: 2, durationMs: 60_000, wallClockCapMs: 600_000 }),
  );
  const slammed = computeRunHealthScore(
    input({ commitsLanded: 3, tier: 2, durationMs: 580_000, wallClockCapMs: 600_000 }),
  );
  assert.ok(slammed.score < ok.score);
});

test("computeRunHealthScore — components surfaced for diagnostics", () => {
  const got = computeRunHealthScore(
    input({ commitsLanded: 2, tier: 1, retryCount: 3, errorCount: 1 }),
  );
  assert.equal(got.components.retryPenalty, -3);
  assert.equal(got.components.errorPenalty, -2);
  assert.ok(got.components.artifactPoints > 0);
  assert.ok(got.components.tierPoints > 0);
});

test("computeRunHealthScore — reason text always populated", () => {
  for (const errs of [0, 5, 50]) {
    const got = computeRunHealthScore(input({ errorCount: errs }));
    assert.ok(got.reason.length > 0);
  }
});

test("computeRunHealthScore — tier alone (no commits) still gives partial credit", () => {
  const got = computeRunHealthScore(input({ tier: 2 }));
  // 60 + tierPoints(10) = 70, no penalties
  assert.equal(got.score, 70);
});

test("computeRunHealthScore — totalTurns=0 doesn't divide by zero", () => {
  const got = computeRunHealthScore(input({ totalTurns: 0, emptyTurns: 0 }));
  assert.ok(Number.isFinite(got.score));
});

test("computeRunHealthScore — green reason mentions commits + tier", () => {
  const got = computeRunHealthScore(
    input({ commitsLanded: 5, tier: 3 }),
  );
  assert.match(got.reason, /commits/i);
  assert.match(got.reason, /tier/i);
});
