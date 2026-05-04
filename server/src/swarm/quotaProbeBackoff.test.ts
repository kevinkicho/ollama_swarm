// R2 (2026-05-04): tests for exponential quota-probe back-off.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextQuotaProbeDelayMs,
  formatProbeDelayLabel,
  QUOTA_PROBE_BASE_MS,
  QUOTA_PROBE_CAP_MS,
} from "./quotaProbeBackoff.js";

test("nextQuotaProbeDelayMs — attempt 0 → 1 min", () => {
  assert.equal(nextQuotaProbeDelayMs(0), 60_000);
});

test("nextQuotaProbeDelayMs — attempt 1 → 2 min", () => {
  assert.equal(nextQuotaProbeDelayMs(1), 120_000);
});

test("nextQuotaProbeDelayMs — attempt 2 → 4 min", () => {
  assert.equal(nextQuotaProbeDelayMs(2), 240_000);
});

test("nextQuotaProbeDelayMs — attempt 3 → 8 min", () => {
  assert.equal(nextQuotaProbeDelayMs(3), 480_000);
});

test("nextQuotaProbeDelayMs — attempt 4 → 16 min", () => {
  assert.equal(nextQuotaProbeDelayMs(4), 960_000);
});

test("nextQuotaProbeDelayMs — attempt 5 → capped at 30 min (would be 32)", () => {
  assert.equal(nextQuotaProbeDelayMs(5), QUOTA_PROBE_CAP_MS);
});

test("nextQuotaProbeDelayMs — large attempt stays at cap", () => {
  assert.equal(nextQuotaProbeDelayMs(20), QUOTA_PROBE_CAP_MS);
  assert.equal(nextQuotaProbeDelayMs(100), QUOTA_PROBE_CAP_MS);
});

test("nextQuotaProbeDelayMs — negative attempt → base", () => {
  assert.equal(nextQuotaProbeDelayMs(-1), QUOTA_PROBE_BASE_MS);
});

test("nextQuotaProbeDelayMs — NaN attempt → base", () => {
  assert.equal(nextQuotaProbeDelayMs(Number.NaN), QUOTA_PROBE_BASE_MS);
});

test("nextQuotaProbeDelayMs — non-decreasing across the curve", () => {
  let prev = 0;
  for (let i = 0; i < 10; i++) {
    const cur = nextQuotaProbeDelayMs(i);
    assert.ok(cur >= prev, `attempt ${i}: ${cur} < ${prev}`);
    prev = cur;
  }
});

test("formatProbeDelayLabel — 60s → '1 min'", () => {
  assert.equal(formatProbeDelayLabel(60_000), "1 min");
});

test("formatProbeDelayLabel — 30 min", () => {
  assert.equal(formatProbeDelayLabel(QUOTA_PROBE_CAP_MS), "30 min");
});
