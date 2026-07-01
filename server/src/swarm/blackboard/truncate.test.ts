import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "./truncate.js";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    assert.equal(truncate("hello"), "hello");
    assert.equal(truncate("a".repeat(80)), "a".repeat(80));
  });

  it("truncates long strings with ellipsis", () => {
    const long = "a".repeat(100);
    const expected = "a".repeat(79) + "…";
    assert.equal(truncate(long), expected);
    assert.equal(truncate(long).length, 80);
  });

  it("respects custom max length", () => {
    assert.equal(truncate("hello world", 5), "hell…");
    assert.equal(truncate("abc", 10), "abc");
  });

  it("handles exactly-max strings at boundary", () => {
    const s = "x".repeat(80);
    assert.equal(truncate(s), s);
    assert.equal(truncate(s, 80), s);
    assert.equal(truncate(s + "y", 80), "x".repeat(79) + "…");
  });

  it("handles empty string", () => {
    assert.equal(truncate(""), "");
  });

  it("handles very small max values", () => {
    assert.equal(truncate("hello", 1), "…");
    assert.equal(truncate("hello", 2), "h…");
  });

  it("does not truncate when string equals max", () => {
    assert.equal(truncate("hi", 2), "hi");
  });

  it("truncates exactly one char above max", () => {
    assert.equal(truncate("abc", 2), "a…");
  });
});
