// R7 (2026-05-04): tests for browser-close pause policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSubscriberAction } from "./subscriberPausePolicy.js";

test("decideSubscriberAction — last subscriber drops → pause", () => {
  const got = decideSubscriberAction({
    prevCount: 1,
    newCount: 0,
    pausedDueToDisconnect: false,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "pause");
});

test("decideSubscriberAction — already paused-due-to-disconnect, drop → no-change", () => {
  const got = decideSubscriberAction({
    prevCount: 1,
    newCount: 0,
    pausedDueToDisconnect: true,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "no-change");
});

test("decideSubscriberAction — first subscriber arrives, was disconnected → resume", () => {
  const got = decideSubscriberAction({
    prevCount: 0,
    newCount: 1,
    pausedDueToDisconnect: true,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "resume");
});

test("decideSubscriberAction — first subscriber but not pausedDueToDisconnect → no-change", () => {
  const got = decideSubscriberAction({
    prevCount: 0,
    newCount: 1,
    pausedDueToDisconnect: false,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "no-change");
});

test("decideSubscriberAction — subscriber arrives BUT quota-paused → no-change", () => {
  const got = decideSubscriberAction({
    prevCount: 0,
    newCount: 1,
    pausedDueToDisconnect: true,
    pausedDueToOther: true, // quota wall still active
  });
  assert.equal(got.action, "no-change");
});

test("decideSubscriberAction — 2 → 1 (dropped one but still subscribers) → no-change", () => {
  const got = decideSubscriberAction({
    prevCount: 2,
    newCount: 1,
    pausedDueToDisconnect: false,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "no-change");
});

test("decideSubscriberAction — 1 → 2 (additional subscriber) → no-change", () => {
  const got = decideSubscriberAction({
    prevCount: 1,
    newCount: 2,
    pausedDueToDisconnect: false,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "no-change");
});

test("decideSubscriberAction — 0 → 0 (no change) → no-change", () => {
  const got = decideSubscriberAction({
    prevCount: 0,
    newCount: 0,
    pausedDueToDisconnect: true,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "no-change");
});

test("decideSubscriberAction — 5 → 0 (all dropped at once) → pause", () => {
  const got = decideSubscriberAction({
    prevCount: 5,
    newCount: 0,
    pausedDueToDisconnect: false,
    pausedDueToOther: false,
  });
  assert.equal(got.action, "pause");
});

test("decideSubscriberAction — reason text always populated", () => {
  const cases: Array<Parameters<typeof decideSubscriberAction>[0]> = [
    { prevCount: 1, newCount: 0, pausedDueToDisconnect: false, pausedDueToOther: false },
    { prevCount: 0, newCount: 1, pausedDueToDisconnect: true, pausedDueToOther: false },
    { prevCount: 1, newCount: 1, pausedDueToDisconnect: false, pausedDueToOther: false },
  ];
  for (const c of cases) {
    const got = decideSubscriberAction(c);
    assert.ok(got.reason.length > 0);
  }
});
