import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createIntraStreamLoopDetector, type IntraStreamLoopDetector } from "./intraStreamLoopDetector.js";

describe("createIntraStreamLoopDetector", () => {
  test("no loop detected for diverse chunks", () => {
    const d = createIntraStreamLoopDetector();
    const texts = [
      "Hello",
      "Hello world",
      "Hello world this",
      "Hello world this is",
      "Hello world this is a",
      "Hello world this is a test",
      "Hello world this is a test of",
      "Hello world this is a test of the",
      "Hello world this is a test of the detector",
      "Hello world this is a test of the detector system",
    ];
    for (const t of texts) {
      const result = d.onChunk(t);
      assert.equal(result.detected, false);
    }
    assert.equal(d.chunkCount, texts.length);
  });

  test("detects identical delta streak (repeated block size)", () => {
    const d = createIntraStreamLoopDetector({ windowSize: 8, threshold: 0.75, minChunksBeforeCheck: 5, minLengthBeforeCheck: 50 });
    // Simulate a model emitting the same JSON block over and over:
    // each chunk adds exactly 25 bytes of the repeated pattern
    const block = '{"tool":"read","path":"x.ts"}';
    let cumulative = "";
    // First 4 chunks: normal diverse text (below minChunksBeforeCheck)
    for (let i = 0; i < 4; i++) {
      cumulative += `diverse text chunk ${i} `.padEnd(30, "x");
      const r = d.onChunk(cumulative);
      assert.equal(r.detected, false, `should not detect at chunk ${i}`);
    }
    // Now emit 10 identical-delta chunks (same block repeated)
    for (let i = 0; i < 10; i++) {
      cumulative += block;
      const r = d.onChunk(cumulative);
      if (r.detected) {
        // Once detected, we're done — either delta streak or suffix repetition
        assert.ok(r.repeatCount >= 3, `repeatCount should be >= 3, got ${r.repeatCount}`);
        return;
      }
    }
    // Should have detected by now
    assert.fail("Expected loop detection within 10 identical-delta chunks");
  });

  test("does not detect before minChunksBeforeCheck threshold", () => {
    const d = createIntraStreamLoopDetector({ minChunksBeforeCheck: 10, minLengthBeforeCheck: 0 });
    // Emit 9 identical chunks (below minChunksBeforeCheck=10)
    let text = "";
    for (let i = 0; i < 9; i++) {
      text += "AAAA";
      const r = d.onChunk(text);
      assert.equal(r.detected, false, `should not detect at chunk ${i}`);
    }
  });

  test("does not detect before minLengthBeforeCheck threshold", () => {
    const d = createIntraStreamLoopDetector({ minChunksBeforeCheck: 3, minLengthBeforeCheck: 500 });
    // Emit 10 chunks of "A" repeated — well above minChunksBeforeCheck but below minLengthBeforeCheck
    let text = "";
    for (let i = 0; i < 10; i++) {
      text += "AAAA";
      const r = d.onChunk(text);
      assert.equal(r.detected, false, `should not detect at length ${text.length}`);
    }
  });

  test("detects trailing substring repetition", () => {
    const d = createIntraStreamLoopDetector({ minChunksBeforeCheck: 3, minLengthBeforeCheck: 100, windowSize: 20 });
    // Build up diverse content — each chunk must be unique, not repeating
    let text = "This is a unique opening sentence about software engineering. ";
    text += "It contains diverse words that should not trigger any repetition. ";
    text += "We pad it past minLength so the detector starts checking. ";
    d.onChunk(text);
    // Add more unique text
    text += "Another chunk with different content about testing. ";
    d.onChunk(text);
    text += "Yet another paragraph discussing algorithms and data structures. ";
    d.onChunk(text);
    // Now append a repeating pattern that's clearly looping
    const repeat = '{"tool":"read","path":"src/x.ts"}';
    for (let i = 0; i < 5; i++) {
      text += repeat;
      const r = d.onChunk(text);
      if (r.detected) {
        assert.ok(r.reason.includes("suffix"), `reason should mention suffix: ${r.reason}`);
        return;
      }
    }
    // With 5 repeats, should definitely detect
    assert.fail("Expected loop detection from trailing substring repetition");
  });

  test("detects zero-byte streak (model emitting nothing)", () => {
    const d = createIntraStreamLoopDetector({ minChunksBeforeCheck: 3, minLengthBeforeCheck: 0, windowSize: 10 });
    // Start with some content
    let text = "Hello world this is a test";
    d.onChunk(text);
    // Then emit 6 chunks of no new text
    let detected = false;
    for (let i = 0; i < 6; i++) {
      const r = d.onChunk(text); // same text = 0 bytes added
      if (r.detected) {
        assert.ok(r.reason.includes("zero-byte"), `reason should mention zero-byte: ${r.reason}`);
        detected = true;
        break;
      }
    }
    assert.ok(detected, "Should detect zero-byte streak");
  });

  test("reset clears state", () => {
    const d = createIntraStreamLoopDetector({ minChunksBeforeCheck: 3, minLengthBeforeCheck: 0 });
    d.onChunk("hello");
    d.onChunk("hello world");
    assert.equal(d.chunkCount, 2);
    d.reset();
    assert.equal(d.chunkCount, 0);
    // After reset, should not carry over old state
    const r = d.onChunk("fresh start");
    assert.equal(r.detected, false);
    assert.equal(d.chunkCount, 1);
  });

  test("does not false-positive on slowly growing diverse content", () => {
    const d = createIntraStreamLoopDetector();
    // Simulate realistic streaming: each chunk adds different amounts
    const chunks = [
      "The quick brown fox",
      "The quick brown fox jumped over",
      "The quick brown fox jumped over the lazy dog",
      "The quick brown fox jumped over the lazy dog and then",
      "The quick brown fox jumped over the lazy dog and then ran away",
      "The quick brown fox jumped over the lazy dog and then ran away into the forest",
    ];
    for (const chunk of chunks) {
      const r = d.onChunk(chunk);
      assert.equal(r.detected, false);
    }
  });

  test("threshold parameter controls sensitivity", () => {
    // High threshold (0.95) should be less sensitive than low threshold (0.6)
    const d_strict = createIntraStreamLoopDetector({ threshold: 0.95, minChunksBeforeCheck: 3, minLengthBeforeCheck: 0, windowSize: 10 });
    const d_loose = createIntraStreamLoopDetector({ threshold: 0.6, minChunksBeforeCheck: 3, minLengthBeforeCheck: 0, windowSize: 10 });

    // Mix of 6 identical deltas with 4 diverse ones
    let text = "";
    const sizes = [10, 25, 10, 10, 10, 10, 10, 10, 15, 30];
    let strictDetected = false;
    let looseDetected = false;
    for (const size of sizes) {
      text += "x".repeat(size);
      const r1 = d_strict.onChunk(text);
      const r2 = d_loose.onChunk(text);
      if (r1.detected) strictDetected = true;
      if (r2.detected) looseDetected = true;
    }
    // With 6/10 identical deltas, loose should fire; strict might not
    assert.ok(looseDetected, "Loose threshold should detect the loop");
  });

  test("detects pseudo-tool-call storm after warmup prose", () => {
    const d = createIntraStreamLoopDetector({
      minChunksBeforeCheck: 3,
      minLengthBeforeCheck: 50,
      maxPseudoToolMarkers: 100,
      pseudoToolBurstPerChunk: 30,
    });
    const warmup = [
      "Exploring the repo before drafting the contract.",
      "Reading module index and route files.",
      "Checking config entries for missing handlers.",
      "Scanning source tree for gaps.",
      "Preparing contract criteria list.",
    ];
    let text = "";
    for (const line of warmup) {
      text += `${line}\n`;
      assert.equal(d.onChunk(text).detected, false);
    }
    const burst = Array.from({ length: 40 }, (_, i) => `<read path='src/burst${i}.ts' />`).join("\n");
    const r = d.onChunk(`${text}\n${burst}`);
    assert.match(r.reason, /pseudo-tool-call/);
  });
});