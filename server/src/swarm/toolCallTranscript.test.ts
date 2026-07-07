import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWebToolSystemLine,
  webToolCallSummary,
} from "./toolCallTranscript.js";

describe("toolCallTranscript", () => {
  it("formats web tool system lines and summaries", () => {
    const line = formatWebToolSystemLine("agent-1", "web_search", true, "arxiv results");
    assert.match(line, /agent-1.*web_search.*ok/);
    const summary = webToolCallSummary("web_fetch", false, "timeout");
    assert.equal(summary.kind, "web_tool");
    assert.equal(summary.ok, false);
    assert.equal(summary.preview, "timeout");
  });
});