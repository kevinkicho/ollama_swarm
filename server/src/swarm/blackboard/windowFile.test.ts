import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  windowFileForWorker,
  windowFileWithAnchors,
  WORKER_ANCHOR_LINES_AFTER,
  WORKER_ANCHOR_LINES_BEFORE,
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

// Unit 44b: anchor-windowed view. Solves "middle row of large file is
// invisible to the worker" — the planner declares a few anchor strings,
// the runner pre-resolves them, and we inject ±25 lines of context
// around each match alongside the head + tail.
describe("windowFileWithAnchors — small file (under threshold)", () => {
  it("returns full content with empty anchorReports when no anchors are declared", () => {
    const src = "alpha\nbeta\ngamma\n";
    const r = windowFileWithAnchors(src, []);
    assert.equal(r.full, true);
    assert.equal(r.content, src);
    assert.deepEqual(r.anchorReports, []);
  });

  it("still reports per-anchor hits even when the file is small enough to show in full", () => {
    // The planner shouldn't be punished for declaring an anchor on a small file —
    // the report tells it which anchors actually matched so future tier-up logic
    // can flag misses without re-reading the file.
    const src = "row 1\nrow 2 SPECIAL\nrow 3\n";
    const r = windowFileWithAnchors(src, ["SPECIAL", "MISSING"]);
    assert.equal(r.full, true);
    assert.equal(r.content, src);
    assert.equal(r.anchorReports.length, 2);
    assert.equal(r.anchorReports[0]!.anchor, "SPECIAL");
    assert.equal(r.anchorReports[0]!.found, 2, "SPECIAL is on line 2");
    assert.equal(r.anchorReports[1]!.found, null, "MISSING is not in the file");
  });
});

describe("windowFileWithAnchors — large file with anchor matches", () => {
  // Build a 200-line markdown table; row 100 has the unique marker.
  // Threshold is 8000, so 200 lines × ~12 chars > threshold.
  function tableWithMarkerAt(line: number, marker: string): string {
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) {
      lines.push(i === line ? `| ${i} | ${marker} | data |` : `| ${i} | row${i} | data |`);
    }
    // Pad to comfortably exceed threshold.
    return lines.join("\n") + "\n" + "x".repeat(WORKER_FILE_WINDOW_THRESHOLD);
  }

  it("includes the matched line and ±25 surrounding lines", () => {
    const src = tableWithMarkerAt(100, "ANCHORED_ROW");
    const r = windowFileWithAnchors(src, ["ANCHORED_ROW"]);
    assert.equal(r.full, false);
    assert.equal(r.anchorReports[0]!.found, 100, "anchor is on line 100");
    assert.ok(r.content.includes("ANCHORED_ROW"), "anchor row text appears in output");
    // ±25 lines around row 100 → rows 75..125 should appear.
    assert.ok(r.content.includes("| 75 | row75 |"), "lower context (line 75) included");
    assert.ok(r.content.includes("| 125 | row125 |"), "upper context (line 125) included");
    // Lines well outside the band should NOT appear in the excerpt — but they
    // CAN appear via head/tail. Pick one that's neither in head nor in the
    // excerpt: row 50 is past the head (head is bytes 0..3000 → roughly first
    // ~150 lines of 20-char rows fit, but row 50 lands well inside head). Use
    // row 160 which is in the excerpt OR tail. Better: assert the excerpt
    // section explicitly via the marker prose.
    assert.ok(
      r.content.includes("ANCHORED EXCERPT"),
      "excerpt section header is present",
    );
  });

  it("merges overlapping anchor windows into a single excerpt", () => {
    // Two anchors 5 lines apart → ±25 windows overlap → should merge into one
    // contiguous excerpt block (no duplicate lines, one header).
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) {
      let label = `row${i}`;
      if (i === 100) label = "ANCHOR_ALPHA";
      else if (i === 105) label = "ANCHOR_BETA";
      lines.push(`| ${i} | ${label} |`);
    }
    const src = lines.join("\n") + "\n" + "x".repeat(WORKER_FILE_WINDOW_THRESHOLD);
    const r = windowFileWithAnchors(src, ["ANCHOR_ALPHA", "ANCHOR_BETA"]);
    // One merged excerpt block, not two
    const excerptHeaders = r.content.match(/ANCHORED EXCERPT/g) ?? [];
    assert.equal(excerptHeaders.length, 1, "overlapping ranges merged into 1 block");
    assert.ok(r.content.includes("ANCHOR_ALPHA"));
    assert.ok(r.content.includes("ANCHOR_BETA"));
  });

  it("emits a 'no anchors found' marker when every anchor misses on a large file", () => {
    const src = "x".repeat(WORKER_FILE_WINDOW_THRESHOLD + 5_000);
    const r = windowFileWithAnchors(src, ["never gonna match"]);
    assert.equal(r.full, false);
    assert.equal(r.anchorReports[0]!.found, null);
    assert.ok(
      r.content.includes("none of the declared anchors were found"),
      "fallback marker present so the model knows the planner's anchors didn't bind",
    );
  });

  it("never returns content longer than the input", () => {
    // Regression guard: the anchored view is still a windowing strategy,
    // not a content amplifier.
    const src = tableWithMarkerAt(100, "ANCHORED_ROW");
    const r = windowFileWithAnchors(src, ["ANCHORED_ROW"]);
    assert.ok(r.content.length <= src.length);
  });

  it("respects the configured before/after line counts", () => {
    // Sanity check that the constants the planner prompt advertises are
    // what's actually emitted. If we ever change them, this test names
    // the dependency.
    assert.equal(WORKER_ANCHOR_LINES_BEFORE, 25);
    assert.equal(WORKER_ANCHOR_LINES_AFTER, 25);
  });
});
