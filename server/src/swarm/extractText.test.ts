import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractText,
  extractTextWithDiag,
  JUNK_QUARANTINE_THRESHOLD,
  looksLikeJunk,
  stripToolCallLeak,
  trackPostRetryJunk,
} from "./extractText.js";

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
  it("returns the extracted text + isEmpty=false when present (no diag fired)", () => {
    let diagCalls = 0;
    const result = extractTextWithDiag(
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
    assert.equal(result.text, "ok");
    assert.equal(result.isEmpty, false);
    assert.equal(diagCalls, 0);
  });

  it("returns '(empty response)' + isEmpty=true AND fires diag when parts is empty", () => {
    let diagPayload: any = null;
    const result = extractTextWithDiag(
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
    assert.equal(result.text, "(empty response)");
    assert.equal(result.isEmpty, true);
    assert.ok(diagPayload, "logDiag should have been called");
    assert.equal(diagPayload.type, "empty_response");
    assert.equal(diagPayload.runner, "test");
    assert.equal(diagPayload.agentId, "agent-2");
    assert.equal(diagPayload.partsLength, 0);
    assert.deepEqual(diagPayload.partTypes, []);
  });

  it("captures part types for diagnostics when only non-text parts present", () => {
    let diagPayload: any = null;
    const result = extractTextWithDiag(
      { data: { parts: [{ type: "tool" }, { type: "tool" }, { type: "metadata" }] } },
      {
        runner: "test",
        agentId: "agent-3",
        logDiag: (rec) => {
          diagPayload = rec;
        },
      },
    );
    assert.equal(result.isEmpty, true);
    assert.ok(diagPayload);
    assert.equal(diagPayload.partsLength, 3);
    assert.deepEqual(
      (diagPayload.partTypes as string[]).sort(),
      ["metadata", "tool"],
    );
  });

  it("works without a logDiag callback (silent fallback)", () => {
    const result = extractTextWithDiag(
      { data: { parts: [] } },
      { runner: "test", agentId: "agent-4" },
    );
    assert.equal(result.text, "(empty response)");
    assert.equal(result.isEmpty, true);
  });

  it("flags extractedEmptyString=true when text is '' (degenerate case)", () => {
    let diagPayload: any = null;
    const result = extractTextWithDiag(
      { data: { text: "" } },
      {
        runner: "test",
        agentId: "agent-5",
        logDiag: (rec) => {
          diagPayload = rec;
        },
      },
    );
    assert.equal(result.isEmpty, true);
    assert.ok(diagPayload);
    assert.equal(diagPayload.extractedEmptyString, true);
  });
});

describe("looksLikeJunk", () => {
  it("flags single-token short outputs (Pattern 8)", () => {
    assert.equal(looksLikeJunk(":"), true);
    assert.equal(looksLikeJunk("4"), true);
    assert.equal(looksLikeJunk("0.5"), true);
    assert.equal(looksLikeJunk("11.4"), true);
    assert.equal(looksLikeJunk(":thumbs_up:"), true);
    assert.equal(looksLikeJunk(":thinking:"), true);
  });

  it("flags trivially-short multi-word outputs", () => {
    assert.equal(looksLikeJunk("Yes, agreed."), true);
    assert.equal(looksLikeJunk("MEXICAN PASSION FRUIT"), true);
  });

  it("Task #112: catches known placeholder strings (any length)", () => {
    assert.equal(looksLikeJunk("(empty response)"), true);
    assert.equal(looksLikeJunk("(content truncated)"), true);
    assert.equal(looksLikeJunk("(No response from Model)"), true);
    // Longer variants — length-based rules wouldn't catch but the pattern does.
    assert.equal(
      looksLikeJunk("(empty response — upstream returned 502 after 30s timeout)"),
      true,
    );
    assert.equal(
      looksLikeJunk("(no response from model after retry attempt 3 of 3)"),
      true,
    );
  });

  it("does NOT flag substantive prose", () => {
    const real =
      "This is a meaningful response that contains actual analysis of the codebase. It cites src/foo.ts:42 and reasons about the architectural choices. It exceeds 30 characters easily.";
    assert.equal(looksLikeJunk(real), false);
  });

  it("does NOT flag empty string (handled separately via isEmpty)", () => {
    assert.equal(looksLikeJunk(""), false);
    assert.equal(looksLikeJunk("   "), false);
  });

  it("Task #114: catches the tool-call leak marker", () => {
    assert.equal(
      looksLikeJunk("(tool-call leak — model emitted protocol tokens as text)"),
      true,
    );
  });
});

describe("stripToolCallLeak (Task #114)", () => {
  it("returns text unchanged when no leak markers present", () => {
    const real = "Real prose response that talks about src/foo.ts:42 and the architecture.";
    assert.equal(stripToolCallLeak(real), real);
  });

  it("truncates at first <|tool_call_begin|> marker", () => {
    const leak =
      'Real synthesis text up to here.\nCONVERGENCE: high\n<|tool_call_begin|>bash{"command":"npm audit"}<|tool_end|>|4|';
    const result = stripToolCallLeak(leak);
    assert.equal(result, "Real synthesis text up to here.\nCONVERGENCE: high");
  });

  it("truncates at first <tool_call_begin|> marker (no leading <|)", () => {
    const leak = 'Some text<tool_call_begin|>bash{"command":"foo"}<|tool_end|>';
    assert.equal(stripToolCallLeak(leak), "Some text");
  });

  it("truncates at </tool> marker", () => {
    const leak = "Real prose.\n</tool>\nmore garbage";
    assert.equal(stripToolCallLeak(leak), "Real prose.");
  });

  it("returns marker placeholder when leak starts at position 0", () => {
    const leak = '<|tool_call_begin|>bash{"command":"npm audit"}<|tool_end|>';
    const result = stripToolCallLeak(leak);
    assert.match(result, /^\(tool-call leak/);
  });

  it("picks earliest of multiple marker types", () => {
    const leak = "prose <|tool_end|> more <|tool_call_begin|>";
    assert.equal(stripToolCallLeak(leak), "prose");
  });

  // Task #134: widened-marker coverage for non-nemotron variants.
  it("truncates at bare <tool_call> XML marker", () => {
    const leak = 'Synthesis prose.\n<tool_call>{"name":"bash"}</tool_call>';
    assert.equal(stripToolCallLeak(leak), "Synthesis prose.");
  });

  it("truncates at <tool_use> XML marker", () => {
    const leak = "Real text.\n<tool_use name=\"foo\"/>";
    assert.equal(stripToolCallLeak(leak), "Real text.");
  });

  it("truncates at <function_call> marker", () => {
    const leak = "Real text. <function_call>...";
    assert.equal(stripToolCallLeak(leak), "Real text.");
  });

  it("truncates at generic <|*tool*|> framed marker", () => {
    const leak = "Prose ends here.\n<|invoke_tool_v2|> garbage";
    assert.equal(stripToolCallLeak(leak), "Prose ends here.");
  });

  it("truncates at generic <|*function*|> framed marker", () => {
    const leak = "Prose. <|function_invoke|>...";
    assert.equal(stripToolCallLeak(leak), "Prose.");
  });
});

// Task #110: Pattern 8 smoke test — exercises the full junk → retry →
// quarantine-warning path that was silently broken before #112/#114/#115.
describe("trackPostRetryJunk (Tasks #110, #115)", () => {
  function makeCtx() {
    const counts = new Map<string, number>();
    const warnings: string[] = [];
    return {
      counts,
      warnings,
      ctx: {
        agentId: "agent-1",
        recordJunkPostRetry: (id: string, isJunk: boolean) => {
          if (isJunk) {
            const next = (counts.get(id) ?? 0) + 1;
            counts.set(id, next);
            return next;
          }
          counts.delete(id);
          return 0;
        },
        appendSystem: (msg: string) => warnings.push(msg),
      },
    };
  }

  it("returns 0 when text is substantive prose", () => {
    const { ctx, warnings } = makeCtx();
    const real =
      "Here is a meaningful agent response that exceeds 30 characters easily and contains real analysis.";
    assert.equal(trackPostRetryJunk(real, ctx), 0);
    assert.equal(warnings.length, 0);
  });

  it("counts consecutive junk turns and warns at threshold", () => {
    const { ctx, warnings } = makeCtx();
    // First two: under threshold, no warning.
    assert.equal(trackPostRetryJunk(":", ctx), 1);
    assert.equal(warnings.length, 0);
    assert.equal(trackPostRetryJunk(":thumbs_up:", ctx), 2);
    assert.equal(warnings.length, 0);
    // Threshold hit on third — warning fires.
    assert.equal(trackPostRetryJunk("4", ctx), JUNK_QUARANTINE_THRESHOLD);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /agent-1.*STUCK.*3 consecutive/i);
  });

  it("resets counter on substantive recovery", () => {
    const { ctx, counts } = makeCtx();
    trackPostRetryJunk(":", ctx);
    trackPostRetryJunk(":", ctx);
    assert.equal(counts.get("agent-1"), 2);
    // Real prose recovers.
    trackPostRetryJunk(
      "This is substantive prose that recovered after junk. Real analysis cited src/foo.ts:42.",
      ctx,
    );
    assert.equal(counts.get("agent-1"), undefined);
  });

  it("throttles repeat warnings (only at threshold + every 5th past it)", () => {
    const { ctx, warnings } = makeCtx();
    // 3 (warn), 4, 5, 6, 7, 8 (warn — 5 past threshold), 9, 10, 11, 12, 13 (warn).
    for (let i = 0; i < 13; i++) trackPostRetryJunk(":", ctx);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /STUCK.*3 consecutive/i);
    assert.match(warnings[1], /still stuck.*8/i);
    assert.match(warnings[2], /still stuck.*13/i);
  });
});
