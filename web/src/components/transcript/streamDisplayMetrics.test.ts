import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  streamDisplayParts,
  streamDoneSubtitle,
  streamLiveSubtitle,
} from "./streamDisplayMetrics";

describe("streamDisplayParts", () => {
  it("counts output chars after think tags are stripped", () => {
    const raw =
      "<think>" + "x".repeat(2400) + "</think>\n" +
      '{"skip":"auditor could not interpret response"}';
    const parts = streamDisplayParts(raw);
    assert.ok(parts.thinkingChars >= 2400);
    assert.ok(parts.outputChars < 100);
    assert.ok(parts.rawChars > parts.outputChars);
    assert.match(parts.finalText, /skip/);
  });

  it("treats pseudo-tool-call markers as non-output", () => {
    const raw = '<read>{"path":"src/foo.ts"}</read>\n{"ok":true}';
    const parts = streamDisplayParts(raw);
    assert.equal(parts.toolCalls.length, 1);
    assert.match(parts.finalText, /"ok"/);
  });
});

describe("streamDoneSubtitle", () => {
  it("uses output chars not raw stream length", () => {
    const parts = streamDisplayParts(
      `<think>${"a".repeat(2000)}</think>{"a":1}`,
    );
    const sub = streamDoneSubtitle(parts, 42);
    assert.match(sub, /done · 7 chars · 42s total/);
    assert.doesNotMatch(sub, /2,000|2000/);
  });
});

describe("streamLiveSubtitle", () => {
  it("labels think-only streams as hidden reasoning", () => {
    const parts = streamDisplayParts(`<think>still working…</think>`);
    const sub = streamLiveSubtitle(parts, 500, false);
    assert.match(sub, /reasoning · .*chars \(hidden\)/);
  });
});