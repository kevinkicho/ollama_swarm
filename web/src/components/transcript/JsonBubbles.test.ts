import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitProseAndJson } from "./JsonBubbles.js";

describe("splitProseAndJson", () => {
  it("splits at first { for standard JSON object", () => {
    const result = splitProseAndJson("explanation {\"key\":1}");
    assert.equal(result.prose, "explanation");
    assert.equal(result.json, '{"key":1}');
  });

  it("splits at first [ for JSON array", () => {
    const result = splitProseAndJson("here is list [1,2,3]");
    assert.equal(result.prose, "here is list");
    assert.equal(result.json, "[1,2,3]");
  });

  it("splits at fenced code block", () => {
    const result = splitProseAndJson("preamble\n```json\n{\"a\":1}\n```");
    assert.equal(result.prose, "preamble");
    assert.equal(result.json, '```json\n{"a":1}\n```');
  });

  it("returns all prose when no JSON found", () => {
    const result = splitProseAndJson("just plain text, nothing json here");
    assert.equal(result.prose, "just plain text, nothing json here");
    assert.equal(result.json, "");
  });

  it("handles empty input", () => {
    const result = splitProseAndJson("");
    assert.equal(result.prose, "");
    assert.equal(result.json, "");
  });

  // Fallback: lenient extraction for non-standard boundaries
  it("handles JSON: prefix via fallback", () => {
    const result = splitProseAndJson("The plan is:\nJSON: {\"steps\":[1,2,3]}");
    assert.ok(result.json.includes('{"steps":[1,2,3]}'));
    assert.ok(result.prose.includes("The plan is:"));
  });

  it("handles JSON after markdown without explicit fence", () => {
    const result = splitProseAndJson("Summary:\n\n```\n{\"done\":true}\n```");
    assert.ok(result.json.includes("```"));
    assert.ok(result.json.includes('{"done":true}'));
  });

  it("handles nested JSON via fallback", () => {
    const result = splitProseAndJson("here: {\"outer\":{\"inner\":1}}");
    assert.equal(result.json, '{"outer":{"inner":1}}');
  });

  it("handles JSON with string content containing braces", () => {
    const result = splitProseAndJson("data: {\"key\":\"val{inside}\"}");
    assert.equal(result.json, '{"key":"val{inside}"}');
  });

  it("handles JSON with escaped quotes", () => {
    const result = splitProseAndJson('text {"k":"v\\"escaped"}');
    assert.equal(result.json, '{"k":"v\\"escaped"}');
  });

  it("handles bare array without prose", () => {
    const result = splitProseAndJson("[1,2,3]");
    assert.equal(result.prose, "");
    assert.equal(result.json, "[1,2,3]");
  });

  it("preserves whitespace in prose", () => {
    const result = splitProseAndJson("line1\nline2\n{\"a\":1}");
    assert.equal(result.prose, "line1\nline2");
    assert.equal(result.json, '{"a":1}');
  });

  it("handles JSON after long preamble via fallback", () => {
    const preamble = "This is a fairly long preamble that has no curly braces or square brackets in it at all.";
    const result = splitProseAndJson(`${preamble} {"status":"ok"}`);
    assert.equal(result.prose, preamble);
    assert.equal(result.json, '{"status":"ok"}');
  });

  it("handles multiple JSON-like sections (picks first)", () => {
    const result = splitProseAndJson('{"first":1} and {"second":2}');
    assert.ok(result.json.startsWith('{"first":1}'));
    assert.notEqual(result.json, '{"second":2}');
  });
});
