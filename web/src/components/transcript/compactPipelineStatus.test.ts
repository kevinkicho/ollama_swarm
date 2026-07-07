import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactPipelineStatusChip,
  compactPipelineStatusText,
  isCompactPipelineStatus,
} from "./compactPipelineStatus.js";
import type { TranscriptEntry } from "../../types.js";

function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, "text">): TranscriptEntry {
  return {
    id: "e1",
    role: "system",
    ts: Date.now(),
    ...partial,
  };
}

describe("compactPipelineStatus", () => {
  it("matches research pre-pass system lines", () => {
    const e = entry({ text: "Research pre-pass: captured 12001 chars of web research notes." });
    assert.equal(isCompactPipelineStatus(e), true);
    assert.equal(compactPipelineStatusChip(e), "research");
    assert.match(compactPipelineStatusText(e), /12001 chars/);
  });

  it("matches literature research lines", () => {
    const e = entry({ text: "[agent-2] Literature research: captured 800 chars of notes." });
    assert.equal(isCompactPipelineStatus(e), true);
    assert.equal(compactPipelineStatusChip(e), "research");
  });

  it("matches web_tool summary entries", () => {
    const e = entry({
      text: "[planner] web_search ok: example",
      summary: { kind: "web_tool", tool: "web_search", ok: true, preview: "example" },
    });
    assert.equal(isCompactPipelineStatus(e), true);
    assert.equal(compactPipelineStatusChip(e), "web_search");
    assert.match(compactPipelineStatusText(e), /web_search ok/);
  });

  it("does not match routine planner system chatter", () => {
    const e = entry({ text: "Planner invocation 2/8." });
    assert.equal(isCompactPipelineStatus(e), false);
  });
});