import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collapsePhraseLoop,
  detectPhraseLoop,
  isDominantStreamLoop,
} from "./streamLoopDetect.js";

const PHRASE =
  "I'll fetch the BIS API to understand the raw SDMX JSON structure, then craft a transformation that yields an array of objects with length > 0. response";

describe("detectPhraseLoop", () => {
  it("detects 9f449937-style final-text loops", () => {
    const text = "preamble thoughts. " + PHRASE.repeat(40);
    const hit = detectPhraseLoop(text);
    assert.ok(hit);
    assert.ok(hit!.count >= 6);
    assert.ok(hit!.coveredRatio >= 0.4);
  });

  it("returns null for normal non-repeating prose", () => {
    const parts: string[] = [];
    for (let i = 0; i < 80; i++) {
      parts.push(
        `Step ${i}: inspect module-${(i * 17) % 97} and note finding-${(i * 31) % 53} about API field set ${i}.`,
      );
    }
    const text = parts.join(" ");
    assert.equal(detectPhraseLoop(text), null);
  });
});

describe("isDominantStreamLoop", () => {
  it("trips at 12k+ with high coverage", () => {
    const text = PHRASE.repeat(100); // ~15k
    const hit = isDominantStreamLoop(text, { minLen: 12_000 });
    assert.ok(hit);
  });
});

describe("collapsePhraseLoop", () => {
  it("collapses long loops for transcript storage", () => {
    const text = "head. " + PHRASE.repeat(80);
    const r = collapsePhraseLoop(text, { minLenToCollapse: 8_000, maxKeep: 2 });
    assert.equal(r.collapsed, true);
    assert.ok(r.text.length < text.length / 4);
    assert.match(r.text, /stream loop collapsed/);
    assert.match(r.text, /head\./);
  });
});
