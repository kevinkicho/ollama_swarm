import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeStreamField } from "./streamFieldMerge.js";

describe("mergeStreamField", () => {
  it("appends deltas", () => {
    assert.equal(mergeStreamField("Hello", " world"), "Hello world");
  });

  it("assigns cumulative snapshots", () => {
    assert.equal(mergeStreamField("Hello", "Hello world"), "Hello world");
  });

  it("ignores shorter prefix rebroadcasts", () => {
    assert.equal(mergeStreamField("Hello world", "Hello"), "Hello world");
  });

  it("handles empty sides", () => {
    assert.equal(mergeStreamField("", "a"), "a");
    assert.equal(mergeStreamField("a", ""), "a");
  });
});
