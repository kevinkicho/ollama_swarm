import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoalList } from "./goalListParser.js";

describe("parseGoalList", () => {
  it("parses a simple numbered list with dot separators", () => {
    const text = "1. Fix login bug\n2. Add tests for auth\n3. Update README";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, [
      "Fix login bug",
      "Add tests for auth",
      "Update README",
    ]);
  });

  it("parses a list with paren separators", () => {
    const text = "1) Refactor parser\n2) Reduce duplication\n3) Improve error messages";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, [
      "Refactor parser",
      "Reduce duplication",
      "Improve error messages",
    ]);
  });

  it("handles multi-line goals", () => {
    const text = "1. Add comprehensive error handling\n   including retry logic\n2. Write integration tests";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, [
      "Add comprehensive error handling including retry logic",
      "Write integration tests",
    ]);
  });

  it("ignores preamble text before first number", () => {
    const text = "Here are the goals:\n\n1. Goal one\n2. Goal two";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["Goal one", "Goal two"]);
  });

  it("stops at TOP marker line", () => {
    const text = "1. First goal\n2. Second goal\nTOP: 2\nSome trailing prose";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["First goal", "Second goal"]);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(parseGoalList(""), []);
  });

  it("handles text with no numbered items", () => {
    assert.deepStrictEqual(parseGoalList("Just some prose\nNo numbers here"), []);
  });

  it("handles single-digit and double-digit numbers", () => {
    const text = "9. Ninth item\n10. Tenth item\n11. Eleventh item";
    const result = parseGoalList(text);
    assert.ok(result.length >= 3);
    assert.equal(result[0], "Ninth item");
    assert.equal(result[1], "Tenth item");
    assert.equal(result[2], "Eleventh item");
  });

  it("ignores lines with only whitespace between goals", () => {
    const text = "1. Goal A\n\n2. Goal B\n\n\n3. Goal C";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["Goal A", "Goal B", "Goal C"]);
  });

  it("handles goals with leading whitespace on number", () => {
    const text = "  1. Indented goal\n  2. Another indented";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["Indented goal", "Another indented"]);
  });

  it("filters out empty items", () => {
    const text = "1. \n2. Real goal";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["Real goal"]);
  });

  it("parses three-digit number followed by dot", () => {
    const text = "1. First\n2. Second\n123. Hundredth item";
    // Only 1-2 digit numbers are matched by the regex; 123 is absorbed as continuation of "Second"
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["First", "Second 123. Hundredth item"]);
  });

  it("handles TOP marker case-insensitively", () => {
    const text = "1. Goal\nTop: 1";
    const result = parseGoalList(text);
    assert.deepStrictEqual(result, ["Goal"]);
  });
});
