import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEntryThinking } from "./AgentThinking";
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