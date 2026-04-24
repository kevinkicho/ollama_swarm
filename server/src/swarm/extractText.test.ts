import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractText, extractTextWithDiag } from "./extractText.js";

describe("extractText", () => {
  it("extracts text from data.parts[].text", () => {
    const res = { data: { parts: [{ type: "text", text: "hello" }] } };
    assert.equal(extractText(res), "hello");
  });

  it("joins multiple text parts with newlines", () => {
    const res = {
      data: {
        parts: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    };
    assert.equal(extractText(res), "line one\nline two");
  });

  it("falls back to data.info.parts when data.parts is missing", () => {
    const res = { data: { info: { parts: [{ type: "text", text: "fallback" }] } } };
    assert.equal(extractText(res), "fallback");
  });

  it("falls back to data.text when no parts arrays present", () => {
    const res = { data: { text: "bare text" } };
    assert.equal(extractText(res), "bare text");
  });

  it("returns undefined when parts is empty", () => {
    assert.equal(extractText({ data: { parts: [] } }), undefined);
  });

  it("returns undefined when only non-text parts present", () => {
    const res = { data: { parts: [{ type: "tool", text: "tool call" }] } };
    assert.equal(extractText(res), undefined);
  });

  it("returns undefined for null / malformed responses", () => {
    assert.equal(extractText(null), undefined);
    assert.equal(extractText({}), undefined);
    assert.equal(extractText({ data: null }), undefined);
  });
});

describe("extractTextWithDiag", () => {
  it("returns the extracted text when present (no diag fired)", () => {
    let diagCalls = 0;
    const text = extractTextWithDiag(
      { data: { parts: [{ type: "text", text: "ok" }] } },
      {
        runner: "test",
        agentId: "agent-1",
        agentIndex: 1,
        logDiag: () => {
          diagCalls++;
        },
      },
    );
    assert.equal(text, "ok");
    assert.equal(diagCalls, 0);
  });

  it("returns '(empty response)' AND fires diag when parts is empty", () => {
    let diagPayload: Record<string, unknown> | null = null;
    const text = extractTextWithDiag(
      { data: { parts: [] } },
      {
        runner: "test",
        agentId: "agent-2",
        agentIndex: 2,
        logDiag: (rec) => {
          diagPayload = rec;
        },
      },
    );
    assert.equal(text, "(empty response)");
    assert.ok(diagPayload, "logDiag should have been called");
    assert.equal(diagPayload!.type, "empty_response");
    assert.equal(diagPayload!.runner, "test");
    assert.equal(diagPayload!.agentId, "agent-2");
    assert.equal(diagPayload!.partsLength, 0);
    assert.deepEqual(diagPayload!.partTypes, []);
  });

  it("captures part types for diagnostics when only non-text parts present", () => {
    let diagPayload: Record<string, unknown> | null = null;
    extractTextWithDiag(
      { data: { parts: [{ type: "tool" }, { type: "tool" }, { type: "metadata" }] } },
      {
        runner: "test",
        agentId: "agent-3",
        logDiag: (rec) => {
          diagPayload = rec;
        },
      },
    );
    assert.ok(diagPayload);
    assert.equal(diagPayload!.partsLength, 3);
    assert.deepEqual(
      (diagPayload!.partTypes as string[]).sort(),
      ["metadata", "tool"],
    );
  });

  it("works without a logDiag callback (silent fallback)", () => {
    const text = extractTextWithDiag(
      { data: { parts: [] } },
      { runner: "test", agentId: "agent-4" },
    );
    assert.equal(text, "(empty response)");
  });

  it("flags extractedEmptyString=true when text is '' (degenerate case)", () => {
    let diagPayload: Record<string, unknown> | null = null;
    extractTextWithDiag(
      { data: { text: "" } },
      {
        runner: "test",
        agentId: "agent-5",
        logDiag: (rec) => {
          diagPayload = rec;
        },
      },
    );
    assert.ok(diagPayload);
    assert.equal(diagPayload!.extractedEmptyString, true);
  });
});
