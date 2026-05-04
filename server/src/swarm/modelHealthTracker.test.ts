// R10 (2026-05-04): tests for proactive model-health tracker.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateModelHealth,
  trimAttemptWindow,
  type AttemptRecord,
} from "./modelHealthTracker.js";

const ts = (n: number): number => 1_700_000_000_000 + n * 1000;

function rec(success: boolean, n = 0): AttemptRecord {
  return { success, ts: ts(n) };
}

test("evaluateModelHealth — empty history → not degraded", () => {
  const got = evaluateModelHealth({
    model: "glm-5.1:cloud",
    recentAttempts: [],
  });
  assert.equal(got.degraded, false);
  assert.equal(got.sampleCount, 0);
});

test("evaluateModelHealth — fewer samples than minSamples → not degraded", () => {
  const got = evaluateModelHealth({
    model: "glm-5.1:cloud",
    recentAttempts: [rec(false, 1), rec(false, 2), rec(false, 3)],
    minSamples: 5,
  });
  assert.equal(got.degraded, false);
  assert.equal(got.successRate, 0);
});

test("evaluateModelHealth — 1/10 success → degraded", () => {
  const attempts = [
    rec(true, 1),
    rec(false, 2),
    rec(false, 3),
    rec(false, 4),
    rec(false, 5),
    rec(false, 6),
    rec(false, 7),
    rec(false, 8),
    rec(false, 9),
    rec(false, 10),
  ];
  const got = evaluateModelHealth({
    model: "glm-5.1:cloud",
    recentAttempts: attempts,
  });
  assert.equal(got.degraded, true);
  assert.equal(got.successRate, 0.1);
});

test("evaluateModelHealth — 8/10 success → healthy", () => {
  const attempts = [
    rec(true, 1),
    rec(true, 2),
    rec(true, 3),
    rec(true, 4),
    rec(true, 5),
    rec(true, 6),
    rec(true, 7),
    rec(true, 8),
    rec(false, 9),
    rec(false, 10),
  ];
  const got = evaluateModelHealth({
    model: "glm-5.1:cloud",
    recentAttempts: attempts,
  });
  assert.equal(got.degraded, false);
  assert.equal(got.successRate, 0.8);
});

test("evaluateModelHealth — exactly threshold → not degraded (strict <)", () => {
  // 5/10 success → 50% which is exactly threshold (not below)
  const attempts = [
    ...Array.from({ length: 5 }, (_, i) => rec(true, i)),
    ...Array.from({ length: 5 }, (_, i) => rec(false, i + 5)),
  ];
  const got = evaluateModelHealth({
    model: "x",
    recentAttempts: attempts,
    successThreshold: 0.5,
  });
  assert.equal(got.degraded, false);
});

test("evaluateModelHealth — windowSize trims older history", () => {
  // Old all-success + recent all-fail → only the last 5 count
  const attempts = [
    ...Array.from({ length: 100 }, (_, i) => rec(true, i)),
    ...Array.from({ length: 5 }, (_, i) => rec(false, 100 + i)),
  ];
  const got = evaluateModelHealth({
    model: "x",
    recentAttempts: attempts,
    windowSize: 5,
    minSamples: 5,
  });
  assert.equal(got.degraded, true);
  assert.equal(got.successRate, 0);
});

test("evaluateModelHealth — custom successThreshold respected", () => {
  // 7/10 success with threshold 0.8 → degraded
  const attempts = [
    ...Array.from({ length: 7 }, (_, i) => rec(true, i)),
    ...Array.from({ length: 3 }, (_, i) => rec(false, i + 7)),
  ];
  const got = evaluateModelHealth({
    model: "x",
    recentAttempts: attempts,
    successThreshold: 0.8,
  });
  assert.equal(got.degraded, true);
});

test("evaluateModelHealth — reason text includes percentage", () => {
  const attempts = Array.from({ length: 10 }, () => rec(false));
  const got = evaluateModelHealth({
    model: "x",
    recentAttempts: attempts,
  });
  assert.match(got.reason, /0%/);
});

test("trimAttemptWindow — trims to last N", () => {
  const recs = Array.from({ length: 20 }, (_, i) => rec(true, i));
  const got = trimAttemptWindow(recs, 5);
  assert.equal(got.length, 5);
  assert.equal(got[0].ts, ts(15));
  assert.equal(got[4].ts, ts(19));
});

test("trimAttemptWindow — already at/under cap → returns clone", () => {
  const recs = [rec(true, 1), rec(false, 2)];
  const got = trimAttemptWindow(recs, 10);
  assert.equal(got.length, 2);
  assert.notStrictEqual(got, recs); // different array reference
});
