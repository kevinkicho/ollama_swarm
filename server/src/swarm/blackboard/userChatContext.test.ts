import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectUserChatEntries,
  formatUserChatBlock,
  normalizeUserChatIntent,
} from "./userChatContext.js";
import type { TranscriptEntry } from "../../types.js";

function userEntry(
  text: string,
  opts?: { intent?: TranscriptEntry["intent"]; targetAgent?: string; ts?: number },
): TranscriptEntry {
  return {
    id: "u1",
    role: "user",
    text,
    ts: opts?.ts ?? 1_700_000_000_000,
    ...(opts?.intent ? { intent: opts.intent } : {}),
    ...(opts?.targetAgent ? { targetAgent: opts.targetAgent } : {}),
  };
}

describe("normalizeUserChatIntent", () => {
  it("defaults unknown to steer", () => {
    assert.equal(normalizeUserChatIntent(undefined), "steer");
    assert.equal(normalizeUserChatIntent("steer"), "steer");
  });
  it("preserves suggest and ask", () => {
    assert.equal(normalizeUserChatIntent("suggest"), "suggest");
    assert.equal(normalizeUserChatIntent("ask"), "ask");
  });
});

describe("collectUserChatEntries", () => {
  it("honors @mention routing", () => {
    const transcript = [
      userEntry("broadcast"),
      userEntry("for agent-2 only", { targetAgent: "agent-2" }),
    ];
    const forAgent2 = collectUserChatEntries(transcript, "agent-2");
    assert.equal(forAgent2.length, 2);
    const forAgent3 = collectUserChatEntries(transcript, "agent-3");
    assert.equal(forAgent3.length, 1);
    assert.equal(forAgent3[0]!.text, "broadcast");
  });
});

describe("formatUserChatBlock", () => {
  it("excludes steer by default", () => {
    const block = formatUserChatBlock([
      { text: "reshape plan", intent: "steer", ts: 1 },
      { text: "check duplicates", intent: "suggest", ts: 2 },
    ]);
    assert.ok(block);
    assert.match(block!, /USER SUGGESTION/);
    assert.match(block!, /check duplicates/);
    assert.doesNotMatch(block!, /reshape plan/);
  });

  it("formats ask with inline-answer guidance", () => {
    const block = formatUserChatBlock([
      { text: "why BOJ?", intent: "ask", ts: 3 },
    ]);
    assert.match(block!, /USER QUESTION/);
    assert.match(block!, /Answer briefly inline/);
  });
});