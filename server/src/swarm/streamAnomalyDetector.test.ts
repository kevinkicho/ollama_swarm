import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectStreamAnomalies } from "./streamAnomalyDetector.js";

describe("detectStreamAnomalies", () => {
  it("returns nothing below minLength", () => {
    assert.deepEqual(detectStreamAnomalies("short"), []);
  });

  it("detects phrase repetition", () => {
    const phrase = "I'll use the IMF Data API: https://www.imf.org/-/api/ ";
    const pad = "x".repeat(10_000);
    const text = pad + phrase.repeat(12);
    const findings = detectStreamAnomalies(text, { minLength: 10_000, minPhraseCount: 8 });
    assert.ok(findings.some((f) => f.kind === "phrase_repeat" && f.count >= 8));
  });

  it("detects trailing suffix repetition", () => {
    const block = "same-block-".repeat(5);
    const text = "y".repeat(10_000) + block.repeat(4);
    const findings = detectStreamAnomalies(text, { minLength: 10_000 });
    assert.ok(findings.some((f) => f.kind === "trailing_suffix_repeat"));
  });

  it("flags length milestones once", () => {
    const text = "z".repeat(105_000);
    const first = detectStreamAnomalies(text, { minLength: 10_000, minPhraseCount: 99 });
    assert.ok(first.some((f) => f.kind === "stream_length" && f.pattern.includes("100")));
    const emitted = new Set(
      first.filter((f) => f.kind === "stream_length").map((f) =>
        Number.parseInt(f.pattern.replace(/[^\d]/g, ""), 10),
      ),
    );
    const second = detectStreamAnomalies(text, { minLength: 10_000, minPhraseCount: 99 }, emitted);
    assert.equal(second.filter((f) => f.kind === "stream_length").length, 0);
  });
});