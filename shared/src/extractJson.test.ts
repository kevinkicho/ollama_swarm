import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFirstBalanced, extractJsonFromText } from "../src/extractJson.js";

describe("extractFirstBalanced", () => {
  it("extracts a balanced object from text", () => {
    const result = extractFirstBalanced('preamble {"key":"value"} suffix');
    assert.equal(result, '{"key":"value"}');
  });

  it("extracts a balanced array from text", () => {
    const result = extractFirstBalanced('preamble [1,2,3] suffix');
    assert.equal(result, "[1,2,3]");
  });

  it("extracts nested objects", () => {
    const result = extractFirstBalanced('x {"a":{"b":1}} y');
    assert.equal(result, '{"a":{"b":1}}');
  });

  it("extracts nested arrays", () => {
    const result = extractFirstBalanced('x [1,[2,3]] y');
    assert.equal(result, "[1,[2,3]]");
  });

  it("returns null when no braces found", () => {
    const result = extractFirstBalanced("no braces here");
    assert.equal(result, null);
  });

  it("returns null when braces are unbalanced", () => {
    const result = extractFirstBalanced("{unbalanced");
    assert.equal(result, null);
  });

  it("returns null when array brackets are unbalanced", () => {
    const result = extractFirstBalanced("[unbalanced");
    assert.equal(result, null);
  });

  it("picks the first opening character for matching", () => {
    const result = extractFirstBalanced('[a] {"b":1}');
    assert.equal(result, "[a]");
  });

  it("handles string contents with braces correctly", () => {
    const result = extractFirstBalanced('{"key":"val{inside}"}');
    assert.equal(result, '{"key":"val{inside}"}');
  });

  it("handles escaped quotes inside strings", () => {
    const result = extractFirstBalanced('{"k":"v\\"escaped"}');
    assert.equal(result, '{"k":"v\\"escaped"}');
  });

  it("handles escaped backslashes", () => {
    const result = extractFirstBalanced('{"k":"v\\\\"}');
    assert.equal(result, '{"k":"v\\\\"}');
  });

  it("stops at first balanced close, not last brace", () => {
    const result = extractFirstBalanced('{"a":1} extra {"b":2}');
    assert.equal(result, '{"a":1}');
  });

  it("returns null for empty string", () => {
    const result = extractFirstBalanced("");
    assert.equal(result, null);
  });
});

describe("extractJsonFromText", () => {
  it("unwraps a fenced json block", () => {
    const result = extractJsonFromText('```json\n{"a":1}\n```');
    assert.equal(result, '{"a":1}');
  });

  it("unwraps a fenced block without json tag", () => {
    const result = extractJsonFromText('```\n{"a":1}\n```');
    assert.equal(result, '{"a":1}');
  });

  it("unwraps an inner fenced block with surrounding text", () => {
    const result = extractJsonFromText('preamble\n```json\n{"a":1}\n```\npostamble');
    assert.equal(result, '{"a":1}');
  });

  it("falls back to raw extraction when no fence", () => {
    const result = extractJsonFromText('some text {"a":1} more');
    assert.equal(result, '{"a":1}');
  });

  it("returns null when no JSON found", () => {
    const result = extractJsonFromText("just plain text, no json here");
    assert.equal(result, null);
  });

  it("returns fenced content as-is when not balanced", () => {
    const result = extractJsonFromText("```json\nnot valid json\n```");
    assert.equal(result, "not valid json");
  });

  it("handles trimmed input", () => {
    const result = extractJsonFromText('  \n{"a":1}\n  ');
    assert.equal(result, '{"a":1}');
  });

  it("extracts array from fence", () => {
    const result = extractJsonFromText("```json\n[1,2,3]\n```");
    assert.equal(result, "[1,2,3]");
  });

  it("extracts nested JSON from fence", () => {
    const result = extractJsonFromText('```json\n{"nested":{"deep":true}}\n```');
    assert.equal(result, '{"nested":{"deep":true}}');
  });

  it("extracts JSON after closed think tag", () => {
    const result = extractJsonFromText(
      '<think>planning</think>\n{"hunks":[{"op":"create","file":"a.js","content":"x"}]}',
    );
    assert.ok(result);
    assert.match(result!, /"hunks"/);
  });

  it("extracts JSON after unclosed think tag", () => {
    const result = extractJsonFromText(
      '<think>We need to emit JSON now\n{"approve":true,"reason":"ok"}',
    );
    assert.equal(result, '{"approve":true,"reason":"ok"}');
  });
});
