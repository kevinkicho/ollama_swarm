import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDiscussionStopReason,
  isDiscussionGiveUpStop,
} from "./runSummary.js";

test("isDiscussionGiveUpStop recognizes council give-up prefixes", () => {
  assert.equal(isDiscussionGiveUpStop("audit-stuck: same 5 criteria unmet for 3 cycles"), true);
  assert.equal(isDiscussionGiveUpStop("ambition-failed: tier promotion failed 3 times"), true);
  assert.equal(isDiscussionGiveUpStop("judge-confidence-high after round 2/4"), false);
});

test("classifyDiscussionStopReason maps audit-stuck to no-progress", () => {
  const { stopReason, stopDetail } = classifyDiscussionStopReason({
    crashMessage: undefined,
    stopping: false,
    earlyStopDetail: "audit-stuck: same 4 criteria unmet for 3 cycles",
  });
  assert.equal(stopReason, "no-progress");
  assert.equal(stopDetail, "audit-stuck: same 4 criteria unmet for 3 cycles");
});

test("classifyDiscussionStopReason keeps generic early-stop for non give-up", () => {
  const { stopReason } = classifyDiscussionStopReason({
    stopping: false,
    earlyStopDetail: "judge-confidence-high after round 2/4",
  });
  assert.equal(stopReason, "early-stop");
});

test("classifyDiscussionStopReason maps provider-quota to no-progress with detail", () => {
  const { stopReason, stopDetail } = classifyDiscussionStopReason({
    stopping: false,
    earlyStopDetail: "provider-quota: unmet criteria after transport/429 stalls (not a code deadlock)",
  });
  assert.equal(stopReason, "no-progress");
  assert.match(stopDetail ?? "", /provider-quota/);
});