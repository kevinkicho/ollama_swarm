import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAgentDisplayText,
  resolveEntryPrompt,
  resolveEntryThinking,
  resolveEntryToolTrace,
  toolTraceToggleLabel,
} from "./AgentThinking";
import type { TranscriptEntry } from "../../types";

function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "text">): TranscriptEntry {
  return {
    id: "e1",
    role: "agent",
    agentIndex: 1,
    ts: Date.now(),
    ...partial,
  };
}

describe("resolveEntryThinking", () => {
  it("prefers server-stripped thoughts over stream snapshot", () => {
    const resolved = resolveEntryThinking(
      entry({
        text: '{"issues":[]}',
        thoughts: "reasoning preamble",
        streamSnapshot: { text: "streamed buffer differs" },
      }),
    );
    assert.equal(resolved?.source, "thoughts");
    assert.equal(resolved?.text, "reasoning preamble");
  });

  it("uses stream snapshot when it differs from final text", () => {
    const resolved = resolveEntryThinking(
      entry({
        text: '{"issues":[]}',
        streamSnapshot: {
          text: "partial json stream",
          streamingMeta: { startedAt: 0, lastTextAt: 0, toolCallCount: 0, totalSeconds: 9 },
        },
      }),
    );
    assert.equal(resolved?.source, "stream");
    assert.equal(resolved?.seconds, 9);
  });

  it("recovers thinking from legacy inline <think> tags when thoughts field missing", () => {
    const resolved = resolveEntryThinking(
      entry({
        text: '<think>plan todos</think>[{"description":"fix"}]',
      }),
    );
    assert.equal(resolved?.source, "thoughts");
    assert.match(resolved?.text ?? "", /plan todos/);
  });

  it("returns null when stream snapshot matches pretty-printed final JSON", () => {
    const json = '[{"issue":"x"}]';
    const resolved = resolveEntryThinking(
      entry({
        text: json,
        streamSnapshot: { text: json },
      }),
    );
    assert.equal(resolved, null);
  });
});

describe("resolveEntryPrompt", () => {
  it("returns prompt text when server attached promptText", () => {
    const resolved = resolveEntryPrompt(
      entry({
        text: '{"hunks":[]}',
        promptText: "Build the feature\n\nREADME:\n...",
        promptLabel: "worker build",
      }),
    );
    assert.equal(resolved?.text.includes("Build the feature"), true);
    assert.equal(resolved?.label, "worker build");
  });

  it("returns null when promptText is absent", () => {
    assert.equal(resolveEntryPrompt(entry({ text: "ok" })), null);
  });
});

describe("resolveEntryToolTrace", () => {
  it("returns trace rows when server attached toolTrace", () => {
    const resolved = resolveEntryToolTrace(
      entry({
        text: "research notes",
        toolTrace: [
          { tool: "read", ok: true, preview: "# API docs" },
          { tool: "list", ok: true, preview: "src/" },
        ],
      }),
    );
    assert.equal(resolved?.length, 2);
    assert.equal(resolved?.[0]?.tool, "read");
  });

  it("returns null when toolTrace is absent", () => {
    assert.equal(resolveEntryToolTrace(entry({ text: "ok" })), null);
  });
});

describe("toolTraceToggleLabel", () => {
  it("includes error count in collapsed label", () => {
    const label = toolTraceToggleLabel(
      [
        { tool: "read", ok: true, preview: "a" },
        { tool: "bash", ok: false, preview: "fail" },
      ],
      false,
    );
    assert.match(label, /Tools \(2, 1 err\)/);
  });
});

describe("resolveAgentDisplayText", () => {
  it("strips inline think tags for legacy synthesis entries", () => {
    const text = '<think>reasoning</think>[{"description":"fix tests"}]';
    const display = resolveAgentDisplayText(entry({ text }));
    assert.doesNotMatch(display, /<think>/);
    assert.match(display, /fix tests/);
  });
});