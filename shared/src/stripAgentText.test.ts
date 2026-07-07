import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAgentText } from "../src/stripAgentText.js";

describe("stripAgentText", () => {
  it("returns text unchanged when no think tags or tool calls", () => {
    const result = stripAgentText("hello world");
    assert.equal(result.finalText, "hello world");
    assert.equal(result.thoughts, "");
    assert.equal(result.toolCalls.length, 0);
  });

  it("extracts think tags and strips them from final text", () => {
    const result = stripAgentText("hello<think>I should think</think>world");
    assert.equal(result.finalText, "helloworld");
    assert.equal(result.thoughts, "I should think");
    assert.equal(result.toolCalls.length, 0);
  });

  it("extracts tool call markers", () => {
    const result = stripAgentText("<read path='src/foo.ts'>content</read>after");
    assert.equal(result.finalText, "after");
    assert.equal(result.thoughts, "");
    assert.equal(result.toolCalls.length, 1);
  });

  it("extracts both think tags and tool calls", () => {
    const result = stripAgentText(
      "<think>plan</think>text<grep path='src/' pattern='test'>content</grep>",
    );
    assert.equal(result.finalText, "text");
    assert.equal(result.thoughts, "plan");
    assert.equal(result.toolCalls.length, 1);
  });

  it("returns empty strings for empty input", () => {
    const result = stripAgentText("");
    assert.equal(result.finalText, "");
    assert.equal(result.thoughts, "");
    assert.equal(result.toolCalls.length, 0);
  });

  it("returns empty finalText for bracket-only output", () => {
    const result = stripAgentText("[]");
    assert.equal(result.finalText, "");
  });

  it("returns empty finalText for brace-only output", () => {
    const result = stripAgentText("{}");
    assert.equal(result.finalText, "");
  });

  it("returns empty finalText for mixed bracket-brace junk", () => {
    const result = stripAgentText("[]]");
    assert.equal(result.finalText, "");
  });

  it("returns empty finalText for whitespace-padded brackets", () => {
    const result = stripAgentText("  []  ");
    assert.equal(result.finalText, "");
  });

  it("surfaces thoughts when think tags wrap the whole content", () => {
    const result = stripAgentText("<think>entire response is reasoning</think>");
    assert.ok(result.thoughts.includes("entire response is reasoning"));
    assert.equal(result.toolCalls.length, 0);
  });

  it("handles multiple think tag blocks", () => {
    const result = stripAgentText(
      "<think>first</think>visible<think>second</think>",
    );
    assert.equal(result.finalText, "visible");
    assert.ok(result.thoughts.includes("first"));
    assert.ok(result.thoughts.includes("second"));
  });

  it("handles multiple tool calls", () => {
    const result = stripAgentText(
      "<read path='a.ts'>c1</read><grep path='b.ts' pattern='x'>c2</grep>",
    );
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.finalText.trim(), "");
  });

  it("handles multiline input", () => {
    const result = stripAgentText(
      "<think>\nstep1\nstep2\n</think>\nline1\n<read path='x.ts'>c</read>\nline3",
    );
    assert.ok(result.thoughts.includes("step1"));
    assert.equal(result.toolCalls.length, 1);
    assert.ok(result.finalText.includes("line1"));
    assert.ok(result.finalText.includes("line3"));
  });

  it("handles self-closing tool call tag", () => {
    const result = stripAgentText("<read path='src/foo.ts' />");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.finalText, "");
  });

  it("preserves non-tool-call XML-like content", () => {
    const result = stripAgentText("use <div> and <span> tags");
    assert.equal(result.finalText, "use <div> and <span> tags");
    assert.equal(result.toolCalls.length, 0);
  });

  it("strips DeepSeek function blocks from thoughts into toolCalls", () => {
    const result = stripAgentText(
      `<think>Plan first.
<function>
<function name>read</function>
<parameter name="path">src/data/marketPanels.js</parameter>
</function></think>{"ok":true}`,
    );
    assert.match(result.thoughts, /Plan first/);
    assert.doesNotMatch(result.thoughts, /<function/);
    assert.equal(result.toolCalls.length, 1);
    assert.match(result.finalText, /"ok"/);
  });
});
