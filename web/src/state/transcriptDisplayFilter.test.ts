import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEntry } from "../types.js";
import {
  attachOrphanStreamSnapshots,
  filterSupersededAgentStreams,
  prepareTranscriptForDisplay,
} from "./transcriptDisplayFilter.js";

describe("transcriptDisplayFilter", () => {
  it("hides agent-stream when a later agent entry exists for same agentId", () => {
    const transcript: TranscriptEntry[] = [
      {
        id: "s1",
        role: "agent-stream",
        agentId: "agent-2",
        agentIndex: 2,
        text: "[{\"issue\":\"a\"}]",
        ts: 1,
      },
      {
        id: "f1",
        role: "agent",
        agentId: "agent-2",
        agentIndex: 2,
        text: "[{\"issue\":\"a\"}]",
        ts: 2,
        summary: { kind: "council_draft", round: 3, phase: "reveal" },
      },
    ];
    const out = filterSupersededAgentStreams(transcript);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, "f1");
  });

  it("attaches orphan stream snapshot onto the final agent bubble", () => {
    const transcript: TranscriptEntry[] = [
      {
        id: "s1",
        role: "agent-stream",
        agentId: "agent-4",
        agentIndex: 4,
        text: "partial json stream",
        ts: 1,
        streamingMeta: { startedAt: 1, lastTextAt: 2, toolCallCount: 0, totalSeconds: 3 },
      },
      {
        id: "f1",
        role: "agent",
        agentId: "agent-4",
        agentIndex: 4,
        text: "final json response",
        ts: 2,
        summary: { kind: "council_draft", round: 3, phase: "reveal" },
      },
    ];
    const out = attachOrphanStreamSnapshots(transcript);
    assert.equal(out[1]!.streamSnapshot?.text, "partial json stream");
  });

  it("prepareTranscriptForDisplay hides stream and enriches agent entry", () => {
    const transcript: TranscriptEntry[] = [
      {
        id: "s1",
        role: "agent-stream",
        agentId: "agent-4",
        agentIndex: 4,
        text: "stream body",
        ts: 1,
      },
      {
        id: "f1",
        role: "agent",
        agentId: "agent-4",
        agentIndex: 4,
        text: "final body",
        ts: 2,
      },
    ];
    const out = prepareTranscriptForDisplay(transcript);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.streamSnapshot?.text, "stream body");
  });
});