// 2026-05-02 (chat levers #1, #2, #3): tests for the chat-receipt
// helpers — intent-aware system receipt + @mention visibility filter.
// Pure functions, fast, no fixtures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";

describe("formatChatReceipt — intent-aware acknowledgment", () => {
  it("steer receipt mentions planner-tier nudge", () => {
    const r = formatChatReceipt("steer");
    assert.match(r, /\[chat receipt\]/);
    assert.match(r, /Steering nudge/);
    assert.match(r, /planner.tier/);
  });

  it("suggest receipt is low-pressure framing", () => {
    const r = formatChatReceipt("suggest");
    assert.match(r, /Suggestion/);
    assert.match(r, /won't change direction/);
  });

  it("ask receipt commits to inline answer + no direction change", () => {
    const r = formatChatReceipt("ask");
    assert.match(r, /Question/);
    assert.match(r, /answer inline/);
    assert.match(r, /direction unchanged/);
  });

  it("includes 'to <agentId>' clause when targetAgent set", () => {
    const r = formatChatReceipt("steer", "agent-2");
    assert.match(r, /to agent-2/);
  });

  it("omits target clause when targetAgent absent", () => {
    const r = formatChatReceipt("steer");
    // The body legitimately contains 'addition to'; check for the
    // specific 'nudge to <agentId>' pattern instead.
    assert.doesNotMatch(r, /nudge to /);
    assert.doesNotMatch(r, /Steering nudge to/);
  });

  it("falls back to steer behavior on unknown intent (defensive)", () => {
    // The type system enforces ChatIntent at compile time, but the
    // server may decode a JSON payload with a stale value — fallback
    // ensures we don't crash, just treat it as the default.
    const r = formatChatReceipt("nonsense" as unknown as "steer");
    assert.match(r, /Steering nudge/);
  });
});

describe("userEntryVisibleTo — @mention routing filter", () => {
  it("non-user entries are always visible to any agent", () => {
    assert.equal(userEntryVisibleTo({ role: "system" }, "agent-1"), true);
    assert.equal(userEntryVisibleTo({ role: "agent" }, "agent-1"), true);
  });

  it("user entries with no targetAgent broadcast to all agents", () => {
    const e = { role: "user" };
    assert.equal(userEntryVisibleTo(e, "agent-1"), true);
    assert.equal(userEntryVisibleTo(e, "agent-2"), true);
  });

  it("user entries with targetAgent are visible ONLY to that agent", () => {
    const e = { role: "user", targetAgent: "agent-2" };
    assert.equal(userEntryVisibleTo(e, "agent-1"), false);
    assert.equal(userEntryVisibleTo(e, "agent-2"), true);
    assert.equal(userEntryVisibleTo(e, "agent-3"), false);
  });

  it("empty-string targetAgent is treated as broadcast (defensive)", () => {
    // Defensive — a UI bug that submits "" instead of undefined should
    // fall through to broadcast, not silently hide the message from
    // every agent.
    const e = { role: "user", targetAgent: "" };
    assert.equal(userEntryVisibleTo(e, "agent-1"), true);
  });
});
