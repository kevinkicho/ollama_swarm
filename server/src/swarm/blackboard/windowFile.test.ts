import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  windowFileForWorker,
  WORKER_FILE_HEAD_BYTES,
  WORKER_FILE_TAIL_BYTES,
  WORKER_FILE_WINDOW_THRESHOLD,
} from "./windowFile.js";

describe("windowFileForWorker — under threshold returns full content", () => {
  it("returns an empty file verbatim", () => {
    const r = windowFileForWorker("");
    assert.deepEqual(r, { full: true, content: "", originalLength: 0 });
  });

  it("returns a short file verbatim", () => {
    const src = "# Tiny\n\nhello\n";
    const r = windowFileForWorker(src);
    assert.equal(r.full, true);
    assert.equal(r.content, src);
    assert.equal(r.originalLength, src.length);
  });

  it("returns a file exactly at the threshold verbatim", () => {
    const src = "x".repeat(WORKER_FILE_WINDOW_THRESHOLD);
    const r = windowFileForWorker(src);
    assert.equal(r.full, true);
    assert.equal(r.content.length, WORKER_FILE_WINDOW_THRESHOLD);
  });
});

describe("windowFileForWorker — above threshold produces head+marker+tail", () => {
  it("windows a just-over-threshold file", () => {
    const src = "x".repeat(WORKER_FILE_WINDOW_THRESHOLD + 1);
    const r = windowFileForWorker(src);
    assert.equal(r.full, false);
    // content is strictly smaller than source (the point of windowing)
    assert.ok(r.content.length < src.length);
    assert.equal(r.originalLength, src.length);
  });

  it("preserves the first N and last N bytes exactly", () => {
    // Craft a file with distinctive head and tail so we can verify byte-level
    // preservation. We reach past threshold by adding fluff in the middle.
    const head = "HEAD-" + "h".repeat(WORKER_FILE_HEAD_BYTES - "HEAD-".length);
    const tail = "t".repeat(WORKER_FILE_TAIL_BYTES - "-TAIL".length) + "-TAIL";
    const filler = "m".repeat(WORKER_FILE_WINDOW_THRESHOLD); // guarantees above threshold
    const src = head + filler + tail;

    const r = windowFileForWorker(src);
    assert.equal(r.full, false);
    assert.ok(r.content.startsWith(head), "head is preserved at the front");
    assert.ok(r.content.endsWith(tail), "tail is preserved at the end");
  });

  it("includes a marker that reports omitted length and total length", () => {
    const src = "a".repeat(WORKER_FILE_WINDOW_THRESHOLD * 3);
    const r = windowFileForWorker(src);
    assert.equal(r.full, false);
    const omitted = src.length - WORKER_FILE_HEAD_BYTES - WORKER_FILE_TAIL_BYTES;
    assert.match(r.content, new RegExp(`${omitted} chars omitted`));
    assert.match(r.content, new RegExp(`${src.length} chars total`));
  });

  it("marker nudges the worker toward append or anchored replace", () => {
    const src = "z".repeat(WORKER_FILE_WINDOW_THRESHOLD + 1000);
    const r = windowFileForWorker(src);
    // Don't pin exact wording, but these two op hints must be present so a
    // model reading the marker knows how to still make a successful edit.
    assert.match(r.content, /append/i);
    assert.match(r.content, /replace/i);
  });

  it("a 49KB file windows down to well under the threshold (smoking-gun README case)", () => {
    // The original phase11c-medium-v5 c2 failure was a 49KB README.
    const src = "R".repeat(49_000);
    const r = windowFileForWorker(src);
    assert.equal(r.full, false);
    assert.ok(
      r.content.length < WORKER_FILE_WINDOW_THRESHOLD,
      `expected windowed length < ${WORKER_FILE_WINDOW_THRESHOLD}, got ${r.content.length}`,
    );
    // The head-of-file content is still present (i.e. we didn't accidentally
    // truncate everything).
    assert.ok(r.content.startsWith("R".repeat(100)));
    assert.ok(r.content.endsWith("R".repeat(100)));
  });
});

describe("windowFileForWorker — invariants", () => {
  it("is deterministic (same input → same output)", () => {
    const src = "deterministic-" + "a".repeat(WORKER_FILE_WINDOW_THRESHOLD + 500);
    const r1 = windowFileForWorker(src);
    const r2 = windowFileForWorker(src);
    assert.deepEqual(r1, r2);
  });

  it("never produces content longer than the input", () => {
    // Regression guard: the windowing math must always be a reduction.
    const sizes = [
      0,
      WORKER_FILE_WINDOW_THRESHOLD - 1,
      WORKER_FILE_WINDOW_THRESHOLD,
      WORKER_FILE_WINDOW_THRESHOLD + 1,
      WORKER_FILE_WINDOW_THRESHOLD * 10,
      100_000,
    ];
    for (const n of sizes) {
      const src = "x".repeat(n);
      const r = windowFileForWorker(src);
      assert.ok(
        r.content.length <= src.length,
        `size ${n}: windowed (${r.content.length}) > source (${src.length})`,
      );
    }
  });
});
