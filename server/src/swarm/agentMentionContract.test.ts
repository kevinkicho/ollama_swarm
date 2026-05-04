// Q3 (2026-05-04): tests for inter-agent @-mention contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMentionContracts,
  buildPendingMentionsBlock,
  filterMentionsByCooldown,
  isMentionAddressed,
  MENTION_COOLDOWN_TURNS,
  type MentionContract,
} from "./agentMentionContract.js";
import type { TranscriptEntry } from "../types.js";

test("parseMentionContracts — single fenced envelope", () => {
  const text = [
    "Some prose before.",
    "```mention",
    "to: planner",
    "ask: this hunk needs a paired test todo",
    "why: verify says no test exercises the new branch",
    "urgency: should-do",
    "```",
    "More prose after.",
  ].join("\n");
  const got = parseMentionContracts(text);
  assert.equal(got.length, 1);
  assert.equal(got[0].to, "planner");
  assert.match(got[0].ask, /paired test todo/);
  assert.match(got[0].why, /no test exercises/);
  assert.equal(got[0].urgency, "should-do");
});

test("parseMentionContracts — multiple envelopes in one entry", () => {
  const text = [
    "```mention",
    "to: auditor",
    "ask: re-evaluate criterion c2",
    "```",
    "blah",
    "```mention",
    "to: agent-3",
    "ask: please check src/foo.ts",
    "urgency: blocker",
    "```",
  ].join("\n");
  const got = parseMentionContracts(text);
  assert.equal(got.length, 2);
  assert.equal(got[0].to, "auditor");
  assert.equal(got[1].to, "agent-3");
  assert.equal(got[1].urgency, "blocker");
});

test("parseMentionContracts — missing 'to:' or 'ask:' silently skipped", () => {
  const text = [
    "```mention",
    "ask: do a thing",
    "```",
    "```mention",
    "to: planner",
    "```",
  ].join("\n");
  assert.deepEqual(parseMentionContracts(text), []);
});

test("parseMentionContracts — defaults urgency to should-do when absent or unknown", () => {
  const text = [
    "```mention",
    "to: planner",
    "ask: x",
    "```",
    "```mention",
    "to: planner",
    "ask: y",
    "urgency: maybe-someday",
    "```",
  ].join("\n");
  const got = parseMentionContracts(text);
  assert.equal(got.length, 2);
  assert.equal(got[0].urgency, "should-do");
  assert.equal(got[1].urgency, "should-do");
});

test("parseMentionContracts — case-insensitive field keys", () => {
  const text = ["```mention", "TO: planner", "Ask: x", "WHY: y", "```"].join("\n");
  const got = parseMentionContracts(text);
  assert.equal(got.length, 1);
  assert.equal(got[0].to, "planner");
  assert.equal(got[0].why, "y");
});

test("parseMentionContracts — non-mention fences ignored", () => {
  const text = ["```typescript", "to: planner", "ask: x", "```"].join("\n");
  assert.deepEqual(parseMentionContracts(text), []);
});

test("buildPendingMentionsBlock — empty input → empty string", () => {
  assert.equal(buildPendingMentionsBlock([]), "");
});

test("buildPendingMentionsBlock — renders mentions with from/ASK/WHY/urgency", () => {
  const m: MentionContract = {
    to: "planner",
    ask: "add a paired test",
    why: "verify failed",
    urgency: "should-do",
    fromAgentIndex: 2,
  };
  const block = buildPendingMentionsBlock([m]);
  assert.match(block, /Pending @-mention contracts/);
  assert.match(block, /from Agent 2/);
  assert.match(block, /ASK: add a paired test/);
  assert.match(block, /WHY: verify failed/);
  assert.match(block, /SHOULD-DO/);
});

test("buildPendingMentionsBlock — omits WHY when empty", () => {
  const m: MentionContract = {
    to: "planner",
    ask: "x",
    why: "",
    urgency: "should-do",
    fromAgentIndex: 1,
  };
  const block = buildPendingMentionsBlock([m]);
  assert.equal(block.includes("WHY:"), false);
});

test("filterMentionsByCooldown — pair NOT in window → kept", () => {
  const m: MentionContract = {
    to: "planner",
    ask: "x",
    why: "",
    urgency: "should-do",
    fromAgentIndex: 2,
  };
  const got = filterMentionsByCooldown([m], []);
  assert.equal(got.length, 1);
});

test("filterMentionsByCooldown — pair IN window → dropped", () => {
  const m: MentionContract = {
    to: "planner",
    ask: "x",
    why: "",
    urgency: "should-do",
    fromAgentIndex: 2,
  };
  const got = filterMentionsByCooldown([m], [{ fromIndex: 2, to: "planner" }]);
  assert.equal(got.length, 0);
});

test("filterMentionsByCooldown — only the most-recent N pairs counted", () => {
  const m: MentionContract = {
    to: "planner",
    ask: "x",
    why: "",
    urgency: "should-do",
    fromAgentIndex: 2,
  };
  // Pair appears only OUTSIDE the cooldown window
  const window = [
    { fromIndex: 2, to: "planner" }, // ancient
    ...Array.from({ length: MENTION_COOLDOWN_TURNS }, () => ({
      fromIndex: 99,
      to: "other",
    })),
  ];
  const got = filterMentionsByCooldown([m], window);
  assert.equal(got.length, 1, "ancient (2,planner) outside the cooldown should not block");
});

test("filterMentionsByCooldown — case-insensitive on `to`", () => {
  const m: MentionContract = {
    to: "Planner",
    ask: "x",
    why: "",
    urgency: "should-do",
    fromAgentIndex: 2,
  };
  const got = filterMentionsByCooldown([m], [{ fromIndex: 2, to: "PLANNER" }]);
  assert.equal(got.length, 0);
});

test("isMentionAddressed — agent-2 spoke after the mention → addressed", () => {
  const later: TranscriptEntry[] = [
    { id: "1", role: "agent", agentIndex: 2, text: "I added the test", ts: 200 },
  ];
  const got = isMentionAddressed({
    mention: {
      to: "agent-2",
      ask: "x",
      why: "",
      urgency: "should-do",
      emittedTs: 100,
    },
    laterEntries: later,
  });
  assert.equal(got, true);
});

test("isMentionAddressed — target agent spoke BEFORE the mention → NOT addressed", () => {
  const later: TranscriptEntry[] = [
    { id: "1", role: "agent", agentIndex: 2, text: "x", ts: 50 },
  ];
  const got = isMentionAddressed({
    mention: {
      to: "agent-2",
      ask: "x",
      why: "",
      urgency: "should-do",
      emittedTs: 100,
    },
    laterEntries: later,
  });
  assert.equal(got, false);
});

test("isMentionAddressed — role-label resolves via resolveRole", () => {
  const later: TranscriptEntry[] = [
    { id: "1", role: "agent", agentIndex: 1, text: "ack", ts: 200 },
  ];
  const got = isMentionAddressed({
    mention: {
      to: "planner",
      ask: "x",
      why: "",
      urgency: "should-do",
      emittedTs: 100,
    },
    laterEntries: later,
    resolveRole: (r) => (r === "planner" ? 1 : null),
  });
  assert.equal(got, true);
});
