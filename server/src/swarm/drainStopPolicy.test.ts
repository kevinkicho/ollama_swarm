// R6 (2026-05-04): tests for drain-by-default stop policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideStopAction,
  DOUBLE_CLICK_WINDOW_MS,
} from "./drainStopPolicy.js";

test("decideStopAction — first click → drain", () => {
  const got = decideStopAction({ now: 1000, lastStopAt: null });
  assert.equal(got.action, "drain");
});

test("decideStopAction — second click within 5s → kill", () => {
  const got = decideStopAction({ now: 5000, lastStopAt: 1000 });
  // 4000ms elapsed → within 5000ms window
  assert.equal(got.action, "kill");
});

test("decideStopAction — second click exactly at 5s → kill (boundary)", () => {
  const got = decideStopAction({ now: 6000, lastStopAt: 1000 });
  // 5000ms elapsed → at boundary, within window
  assert.equal(got.action, "kill");
});

test("decideStopAction — second click 5.001s later → drain (outside window)", () => {
  const got = decideStopAction({ now: 6001, lastStopAt: 1000 });
  // 5001ms elapsed → outside 5000ms window
  assert.equal(got.action, "drain");
});

test("decideStopAction — second click way later → drain (treat as fresh)", () => {
  const got = decideStopAction({ now: 1_000_000, lastStopAt: 1000 });
  assert.equal(got.action, "drain");
});

test("decideStopAction — custom window respected", () => {
  // Tighter 1-second window
  const got = decideStopAction({
    now: 3000,
    lastStopAt: 1000,
    windowMs: 1000,
  });
  // 2000ms elapsed → outside 1000ms window
  assert.equal(got.action, "drain");
});

test("decideStopAction — clock skew (now < lastStopAt) → drain", () => {
  const got = decideStopAction({ now: 500, lastStopAt: 1000 });
  // negative elapsed → not "within window"; treat as drain
  assert.equal(got.action, "drain");
});

test("decideStopAction — DOUBLE_CLICK_WINDOW_MS is 5000", () => {
  assert.equal(DOUBLE_CLICK_WINDOW_MS, 5000);
});

test("decideStopAction — reason text always populated", () => {
  for (const lastStopAt of [null, 1000, 100_000]) {
    const got = decideStopAction({ now: 5000, lastStopAt });
    assert.ok(got.reason.length > 0);
  }
});
