import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sniffJsonFormatStream } from "./jsonFormatSniff.js";

describe("sniffJsonFormatStream", () => {
  it("allows short streams", () => {
    const r = sniffJsonFormatStream("hello", { minChars: 100 });
    assert.equal(r.ok, true);
  });

  it("accepts JSON after think block", () => {
    const raw = `<think>${"plan ".repeat(3000)}</think>\n{"hunks":[]}`;
    const r = sniffJsonFormatStream(raw, { minChars: 100 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.phase, "has_json");
  });

  it("fails pure think-only past thinkOnlyMax (eee6718f)", () => {
    const raw = `<think>${"We need to transform the route. ".repeat(800)}</think>`;
    const r = sniffJsonFormatStream(raw, { minChars: 1000, thinkOnlyMax: 5000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /think-only/i);
  });

  it("fails long non-JSON prose without markers", () => {
    const raw = "I will inspect the file and then write changes. ".repeat(400);
    const r = sniffJsonFormatStream(raw, { minChars: 2000 });
    assert.equal(r.ok, false);
  });
});
