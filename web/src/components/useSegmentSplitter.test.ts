import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findContentBoundaries, segmentsFromSplitPoints } from "../components/useSegmentSplitter.js";

describe("findContentBoundaries", () => {
  it("returns empty when prevLen >= text.length", () => {
    const result = findContentBoundaries("abc", 3);
    assert.deepEqual(result, []);
  });

  it("detects paragraph break (double newline)", () => {
    const result = findContentBoundaries("line1\n\nline2", 0);
    assert.deepEqual(result, [7]); // split after \n\n (index 5+2=7)
  });

  it("detects fenced code block", () => {
    const result = findContentBoundaries("text```\ncode", 0);
    assert.deepEqual(result, [7]); // split after ``` (index 4+3=7)
  });

  it("detects markdown headers", () => {
    const result = findContentBoundaries("text\n# Header", 0);
    // \n found at index 4, matched "# " starting at index 5, split BEFORE the #
    assert.deepEqual(result, [5]);
  });

  it("detects <think> tag", () => {
    const result = findContentBoundaries("before<think>reasoning", 0);
    assert.deepEqual(result, [6]); // at the <think> tag
  });

  it("detects </think> tag", () => {
    const result = findContentBoundaries("reasoning</think>after", 0);
    assert.deepEqual(result, [17]); // after </think> (index 9+8=17)
  });

  it("respects prevLen offset", () => {
    const result = findContentBoundaries("AAAA\n\nBBBB", 2);
    // appended: "AA\n\nBBBB", \n\n at index 2 in appended → offset 2+2+2=6
    assert.deepEqual(result, [6]);
  });

  it("handles multiple boundary types", () => {
    const result = findContentBoundaries("a\n\n```\n# h", 0);
    // \n\n@1→3, ```@3→6, \n# header@6→7
    assert.deepEqual(result, [3, 6, 7]);
  });

  it("returns empty for text with no boundaries", () => {
    const result = findContentBoundaries("plain text without any markers", 0);
    assert.deepEqual(result, []);
  });

  it("deduplicates identical split points", () => {
    // ``` is both a code-fence and has no other conflicts
    const result = findContentBoundaries("text\n\n\n# head", 0);
    // Just ensure no duplicates
    const deduped = [...new Set(result)];
    assert.deepEqual(result.length, deduped.length);
  });
});

describe("segmentsFromSplitPoints", () => {
  it("splits text at given offsets", () => {
    const result = segmentsFromSplitPoints("abcdefghi", [3, 6]);
    assert.deepEqual(result, ["abc", "def", "ghi"]);
  });

  it("returns whole text in one segment with no split points", () => {
    const result = segmentsFromSplitPoints("hello world", []);
    assert.deepEqual(result, ["hello world"]);
  });

  it("handles empty string", () => {
    const result = segmentsFromSplitPoints("", []);
    assert.deepEqual(result, [""]);
  });

  it("handles empty string with split points (skips out-of-range)", () => {
    const result = segmentsFromSplitPoints("", [3]);
    assert.deepEqual(result, [""]);
  });

  it("skips split points that are out of range", () => {
    const result = segmentsFromSplitPoints("abc", [0, -1, 99]);
    assert.deepEqual(result, ["abc"]);
  });

  it("skips split points <= cursor (duplicate/out-of-order)", () => {
    const result = segmentsFromSplitPoints("abcdef", [2, 4, 2]);
    assert.deepEqual(result, ["ab", "cd", "ef"]);
  });

  it("splits at start (splitPoint=0)", () => {
    // splitPoint 0 is <= cursor (0+0=0) so it's skipped
    const result = segmentsFromSplitPoints("abc", [0]);
    assert.deepEqual(result, ["abc"]);
  });

  it("splits at end (splitPoint=length)", () => {
    const result = segmentsFromSplitPoints("abc", [3]);
    // cursor=3, slice(0,3)="abc", cursor=3, then slice(3)="" 
    assert.deepEqual(result, ["abc", ""]);
  });

  it("handles single split point", () => {
    const result = segmentsFromSplitPoints("hello", [2]);
    assert.deepEqual(result, ["he", "llo"]);
  });

  it("handles many split points", () => {
    const text = "0123456789";
    const result = segmentsFromSplitPoints(text, [1, 3, 5, 7, 9]);
    assert.deepEqual(result, ["0", "12", "34", "56", "78", "9"]);
  });
});
