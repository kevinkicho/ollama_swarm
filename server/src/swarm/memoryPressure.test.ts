// R13 (2026-05-04): tests for memory-pressure backpressure.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMemoryPressure,
  sampleHeap,
  checkMemoryPressure,
  DEFAULT_PAUSE_RATIO,
  DEFAULT_THROTTLE_RATIO,
} from "./memoryPressure.js";

test("evaluateMemoryPressure — well below threshold → ok", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 100,
    limitBytes: 1000,
  });
  assert.equal(got.level, "ok");
});

test("evaluateMemoryPressure — at throttle threshold → throttle", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 750,
    limitBytes: 1000,
  });
  assert.equal(got.level, "throttle");
});

test("evaluateMemoryPressure — at pause threshold → pause", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 900,
    limitBytes: 1000,
  });
  assert.equal(got.level, "pause");
});

test("evaluateMemoryPressure — above pause → pause", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 999,
    limitBytes: 1000,
  });
  assert.equal(got.level, "pause");
});

test("evaluateMemoryPressure — between throttle and pause → throttle", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 800,
    limitBytes: 1000,
  });
  assert.equal(got.level, "throttle");
});

test("evaluateMemoryPressure — custom thresholds respected", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 600,
    limitBytes: 1000,
    pauseRatio: 0.6,
  });
  assert.equal(got.level, "pause");
});

test("evaluateMemoryPressure — limitBytes <= 0 → ok (defensive)", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 100,
    limitBytes: 0,
  });
  assert.equal(got.level, "ok");
});

test("evaluateMemoryPressure — NaN inputs → ok", () => {
  const got = evaluateMemoryPressure({
    usedBytes: Number.NaN,
    limitBytes: 1000,
  });
  assert.equal(got.level, "ok");
});

test("evaluateMemoryPressure — ratio matches reality", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 800,
    limitBytes: 1000,
  });
  assert.ok(Math.abs(got.ratio - 0.8) < 1e-9);
});

test("evaluateMemoryPressure — reason mentions percentage", () => {
  const got = evaluateMemoryPressure({
    usedBytes: 950,
    limitBytes: 1000,
  });
  assert.match(got.reason, /95%/);
});

test("DEFAULT_PAUSE_RATIO + DEFAULT_THROTTLE_RATIO are sensible", () => {
  assert.equal(DEFAULT_PAUSE_RATIO, 0.9);
  assert.equal(DEFAULT_THROTTLE_RATIO, 0.75);
  assert.ok(DEFAULT_PAUSE_RATIO > DEFAULT_THROTTLE_RATIO);
});

test("sampleHeap — returns positive numbers", () => {
  const got = sampleHeap();
  assert.ok(got.usedBytes > 0);
  assert.ok(got.limitBytes > 0);
});

test("checkMemoryPressure — returns a well-formed verdict", () => {
  const got = checkMemoryPressure();
  assert.ok(["ok", "throttle", "pause"].includes(got.level));
  assert.ok(got.reason.length > 0);
});
