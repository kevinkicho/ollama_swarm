import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractToolCallMarkers } from "./extractToolCallMarkers.js";

describe("extractToolCallMarkers — basic cases", () => {
  it("returns text unchanged when no markers present", () => {
    const r = extractToolCallMarkers("just some prose");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.finalText, "just some prose");
  });

  it("handles empty string", () => {
    const r = extractToolCallMarkers("");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.finalText, "");
  });

  it("extracts a single self-closing <read /> tag", () => {
    const r = extractToolCallMarkers("<read path='src/foo.ts' />actual response");
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0], "<read path='src/foo.ts' />");
    assert.equal(r.finalText, "actual response");
  });

  it("extracts an unclosed <read> opener treated as a single tag", () => {
    const r = extractToolCallMarkers("<read path='src/foo.ts' start_line='1' end_line='100'>final");
    assert.equal(r.toolCalls.length, 1);
    assert.match(r.toolCalls[0]!, /<read path='src\/foo\.ts'/);
    assert.equal(r.finalText, "final");
  });

  it("extracts a paired <list>...</list> with content captured", () => {
    const r = extractToolCallMarkers("<list>src/</list>response");
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0], "<list>src/</list>");
    assert.equal(r.finalText, "response");
  });
});

describe("extractToolCallMarkers — multi-marker cluster", () => {
  it("extracts a real-world cluster of read/grep/list markers (RCA preset 1)", () => {
    // Shape from run af27f55c entry 10 (truncated for the test).
    const text = `<read path='src/supervisor.ts' start_line='1' end_line='100'>
<read path='src/supervisor.ts' start_line='100' end_line='200'>
<grep path='src/supervisor.ts' pattern='retry|backoff'>
<list>src/__tests__/</list>
<glob>src/**/*.ts</glob>

actual response after the cluster`;
    const r = extractToolCallMarkers(text);
    assert.equal(r.toolCalls.length, 5);
    assert.equal(r.finalText, "actual response after the cluster");
  });

  it("preserves marker order in toolCalls array", () => {
    const r = extractToolCallMarkers(
      "<read path='a' /><read path='b' /><grep path='c' />done",
    );
    assert.equal(r.toolCalls.length, 3);
    assert.match(r.toolCalls[0]!, /path='a'/);
    assert.match(r.toolCalls[1]!, /path='b'/);
    assert.match(r.toolCalls[2]!, /path='c'/);
  });

  it("collapses whitespace gaps from removed markers", () => {
    const r = extractToolCallMarkers("para1\n\n\n<list>x</list>\n\n\npara2");
    assert.match(r.finalText, /para1\n\npara2/);
    assert.doesNotMatch(r.finalText, /\n{3,}/);
  });
});

describe("extractToolCallMarkers — edge cases + safety", () => {
  it("does NOT match arbitrary HTML/JSX tags", () => {
    // Only the known tool-call tag names trigger extraction.
    const r = extractToolCallMarkers("<div>not me</div><span>also not me</span>");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.finalText, "<div>not me</div><span>also not me</span>");
  });

  it("does NOT match <think> / <thinking> tags (those are extractThinkTags' job)", () => {
    const r = extractToolCallMarkers("<think>x</think>response");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.finalText, "<think>x</think>response");
  });

  it("preserves the ORIGINAL text when extraction empties everything", () => {
    // All content was tool calls → finalText would be "" but we fall
    // back to the original so the bubble renders SOMETHING.
    const original = "<read path='a' /><list>b</list>";
    const r = extractToolCallMarkers(original);
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.finalText, original);
  });

  it("extracts case-insensitively", () => {
    const r = extractToolCallMarkers("<READ path='x' /><Grep>y</Grep>final");
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.finalText, "final");
  });

  it("handles double-quoted attributes too", () => {
    const r = extractToolCallMarkers('<read path="src/foo.ts" />final');
    assert.equal(r.toolCalls.length, 1);
    assert.match(r.toolCalls[0]!, /path="src\/foo\.ts"/);
    assert.equal(r.finalText, "final");
  });

  it("extracts <bash> and <edit> markers (broader tag coverage)", () => {
    const r = extractToolCallMarkers("<bash>npm test</bash><edit>src/x.ts</edit>done");
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.finalText, "done");
  });

  it("stops at first content matching the tag name (greedy-safe)", () => {
    // If the model emits two <list>...</list> blocks, both should be
    // extracted independently — the regex must NOT greedily match
    // across them.
    const r = extractToolCallMarkers("<list>a</list>middle<list>b</list>");
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.toolCalls[0], "<list>a</list>");
    assert.equal(r.toolCalls[1], "<list>b</list>");
    assert.match(r.finalText, /middle/);
  });

  it("handles very long tool-call clusters (no truncation)", () => {
    // 50 markers in a row.
    const cluster = Array.from({ length: 50 }, (_, i) =>
      `<read path='src/f${i}.ts' />`,
    ).join("\n");
    const r = extractToolCallMarkers(`${cluster}\n\nfinal`);
    assert.equal(r.toolCalls.length, 50);
    assert.equal(r.finalText, "final");
  });
});
