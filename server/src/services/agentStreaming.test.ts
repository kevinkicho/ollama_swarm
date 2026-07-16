import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STREAMING_WS_MAX_CHARS,
  truncateStreamingPayload,
} from "./agentStreaming.js";

describe("truncateStreamingPayload", () => {
  it("passes through short text", () => {
    assert.equal(truncateStreamingPayload("hello"), "hello");
  });

  it("caps long cumulative stream for WS (9f449937)", () => {
    const big = "x".repeat(STREAMING_WS_MAX_CHARS + 50_000);
    const out = truncateStreamingPayload(big);
    assert.ok(out.length <= STREAMING_WS_MAX_CHARS + 80);
    assert.match(out, /stream truncated for UI\/wire/);
    assert.ok(out.startsWith("xxx"));
    assert.ok(out.endsWith("xxx"));
  });
});
