import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUsageFromMessageInfo } from "./AgentManager.js";

// Phase 3 of #314: extractUsageFromMessageInfo is the pure half of the
// session-event capture path in AgentManager.handleSessionEvent. The
// dedupe (capturedUsageMessageIds) lives in the runtime; this test
// covers the predicate + the UsageRecord shape we feed tokenTracker.

test("extractUsageFromMessageInfo — anthropic completed message returns a record", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-opus-4-7",
    time: { completed: 1700000000000 },
    tokens: { input: 1234, output: 567 },
  });
  assert.ok(got);
  assert.equal(got.promptTokens, 1234);
  assert.equal(got.responseTokens, 567);
  assert.equal(got.model, "anthropic/claude-opus-4-7");
  assert.equal(got.path, "/sdk-direct");
  assert.equal(typeof got.ts, "number");
});

test("extractUsageFromMessageInfo — openai gets prefixed correctly too", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    providerID: "openai",
    modelID: "gpt-5-mini",
    time: { completed: 1700000000000 },
    tokens: { input: 100, output: 50 },
  });
  assert.equal(got?.model, "openai/gpt-5-mini");
});

test("extractUsageFromMessageInfo — ollama returns null (proxy already captures it)", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    providerID: "ollama",
    modelID: "glm-5.1:cloud",
    time: { completed: 1700000000000 },
    tokens: { input: 1000, output: 500 },
  });
  assert.equal(got, null);
});

test("extractUsageFromMessageInfo — incomplete message (no time.completed) returns null", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-opus-4-7",
    time: {}, // not completed yet
    tokens: { input: 100, output: 50 },
  });
  assert.equal(got, null);
});

test("extractUsageFromMessageInfo — user role returns null", () => {
  const got = extractUsageFromMessageInfo({
    role: "user",
    providerID: "anthropic",
    modelID: "claude-opus-4-7",
    time: { completed: 1700000000000 },
    tokens: { input: 100, output: 0 },
  });
  assert.equal(got, null);
});

test("extractUsageFromMessageInfo — zero tokens returns null", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-opus-4-7",
    time: { completed: 1700000000000 },
    tokens: { input: 0, output: 0 },
  });
  assert.equal(got, null);
});

test("extractUsageFromMessageInfo — missing modelID falls back to providerID alone", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    providerID: "anthropic",
    // modelID missing
    time: { completed: 1700000000000 },
    tokens: { input: 10, output: 10 },
  });
  assert.equal(got?.model, "anthropic");
});

test("extractUsageFromMessageInfo — missing providerID returns null (can't classify)", () => {
  const got = extractUsageFromMessageInfo({
    role: "assistant",
    modelID: "claude-opus-4-7",
    time: { completed: 1700000000000 },
    tokens: { input: 100, output: 50 },
  });
  assert.equal(got, null);
});
