import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildApplyMissReport,
  buildNearbyExcerpt,
  lineIndexAtOffset,
  normalizeSearchWhitespace,
  truncateForReport,
  NEARBY_EXCERPT_MAX_CHARS,
  NEARBY_LINE_RADIUS,
} from "./applyMissReport.js";
import { applyFileHunks, applyHunks, type Hunk } from "./applyHunks.js";

describe("normalizeSearchWhitespace", () => {
  it("trims trailing spaces and tabs per line", () => {
    assert.equal(normalizeSearchWhitespace("hello  \nworld\t"), "hello\nworld");
  });

  it("strips CR left by CRLF split on \\n", () => {
    assert.equal(normalizeSearchWhitespace("a\r\nb\r\n"), "a\nb\n");
  });

  it("is identity when already clean", () => {
    assert.equal(normalizeSearchWhitespace("hello\nworld"), "hello\nworld");
  });
});

describe("truncateForReport / lineIndexAtOffset", () => {
  it("truncates with ellipsis when over max", () => {
    assert.equal(truncateForReport("abcdef", 4), "abc…");
    assert.equal(truncateForReport("ab", 4), "ab");
  });

  it("maps offsets to line indices", () => {
    const text = "L0\nL1\nL2";
    assert.equal(lineIndexAtOffset(text, 0), 0);
    assert.equal(lineIndexAtOffset(text, 3), 1); // at 'L' of L1
    assert.equal(lineIndexAtOffset(text, text.length), 2);
  });
});

describe("buildNearbyExcerpt", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
  const text = lines.join("\n");

  it("returns file head when focus is null (not found)", () => {
    const excerpt = buildNearbyExcerpt(text, { focusOffset: null, radius: 5 });
    // 2*5+1 = 11 lines starting at 0
    assert.equal(excerpt, lines.slice(0, 11).join("\n"));
  });

  it("returns ±radius lines around first match focus", () => {
    // line-10 starts at sum of "line-N\n" for N=0..9
    const focus = text.indexOf("line-10");
    const excerpt = buildNearbyExcerpt(text, { focusOffset: focus, radius: 2 });
    assert.equal(excerpt, lines.slice(8, 13).join("\n"));
  });

  it("truncates to maxChars", () => {
    const long = "x".repeat(5000);
    const excerpt = buildNearbyExcerpt(long, {
      focusOffset: null,
      maxChars: 50,
    });
    assert.ok(excerpt.length <= 50);
    assert.ok(excerpt.endsWith("…"));
  });

  it("returns empty string for empty file", () => {
    assert.equal(buildNearbyExcerpt(""), "");
  });
});

describe("buildApplyMissReport", () => {
  it("fills uniqueCandidates as empty (PR1) and truncates needle", () => {
    const needle = "n".repeat(300);
    const r = buildApplyMissReport({
      file: "f.ts",
      hunkIndex: 2,
      op: "replace",
      kind: "search_not_found",
      needle,
      matchCount: 0,
      fileText: "alpha\nbeta\n",
      message: "hunk[2] op \"replace\": \"search\" text not found in file",
    });
    assert.equal(r.file, "f.ts");
    assert.equal(r.hunkIndex, 2);
    assert.equal(r.kind, "search_not_found");
    assert.deepEqual(r.uniqueCandidates, []);
    assert.ok(r.needle.length < needle.length);
    assert.ok(r.needle.endsWith("…"));
    assert.match(r.nearbyExcerpt, /alpha/);
  });

  it("focuses nearby excerpt on first match when matchCount > 0", () => {
    const fileText = ["a", "b", "TARGET", "c", "d"].join("\n");
    const r = buildApplyMissReport({
      file: "f.md",
      hunkIndex: 0,
      op: "replace",
      kind: "search_not_unique",
      needle: "TARGET",
      matchCount: 2,
      fileText: fileText + "\nTARGET",
      message: "matches 2 times",
    });
    assert.match(r.nearbyExcerpt, /TARGET/);
    assert.match(r.nearbyExcerpt, /b/);
  });
});

describe("applyFileHunks — structured ApplyMissReport", () => {
  it("search not found → kind search_not_found with miss present", () => {
    const fileText = "# Title\n\nHello world.\n";
    const r = applyFileHunks(fileText, [
      { op: "replace", file: "r.md", search: "missing-anchor", replace: "x" },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /"search" text not found/);
    assert.ok(r.miss);
    assert.equal(r.miss!.kind, "search_not_found");
    assert.equal(r.miss!.op, "replace");
    assert.equal(r.miss!.file, "r.md");
    assert.equal(r.miss!.hunkIndex, 0);
    assert.equal(r.miss!.matchCount, 0);
    assert.equal(r.miss!.needle, "missing-anchor");
    assert.deepEqual(r.miss!.uniqueCandidates, []);
    assert.equal(r.miss!.message, r.error);
    // File head excerpt when not found
    assert.match(r.miss!.nearbyExcerpt, /# Title/);
    assert.ok(r.miss!.nearbyExcerpt.length <= NEARBY_EXCERPT_MAX_CHARS);
  });

  it("search not unique → kind search_not_unique", () => {
    const r = applyFileHunks("foo bar foo baz foo", [
      { op: "replace", file: "r.txt", search: "foo", replace: "X" },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /matches 3 times/);
    assert.ok(r.miss);
    assert.equal(r.miss!.kind, "search_not_unique");
    assert.equal(r.miss!.matchCount, 3);
    assert.equal(r.miss!.needle, "foo");
    // First match focus — excerpt near start of file
    assert.match(r.miss!.nearbyExcerpt, /foo/);
  });

  it("start not found → kind start_not_found for replace_between", () => {
    const r = applyFileHunks("hello\nworld\n", [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Missing",
        replace: "x",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /"start" text not found/);
    assert.ok(r.miss);
    assert.equal(r.miss!.kind, "start_not_found");
    assert.equal(r.miss!.op, "replace_between");
    assert.equal(r.miss!.matchCount, 0);
    assert.equal(r.miss!.needle, "## Missing");
  });

  it("start not unique → kind start_not_unique for replace_between", () => {
    const fileText = "## Sec\none\n## Sec\ntwo\n";
    const r = applyFileHunks(fileText, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Sec",
        replace: "## New\n",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /matches 2 times/);
    assert.ok(r.miss);
    assert.equal(r.miss!.kind, "start_not_unique");
    assert.equal(r.miss!.matchCount, 2);
    assert.equal(r.miss!.needle, "## Sec");
  });

  it("endExclusive not found → kind end_not_found", () => {
    const r = applyFileHunks("## Start\nbody\n## Other\n", [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Start",
        endExclusive: "## Missing End",
        replace: "x",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /"endExclusive" text not found after start/);
    assert.ok(r.miss);
    assert.equal(r.miss!.kind, "end_not_found");
    assert.equal(r.miss!.needle, "## Missing End");
    // Nearby should still include start region
    assert.match(r.miss!.nearbyExcerpt, /## Start/);
  });

  it("success path has no miss field", () => {
    const r = applyFileHunks("# Title\n\nHello world.\n", [
      {
        op: "replace",
        file: "r.md",
        search: "Hello world.",
        replace: "Hello universe.",
      },
    ]);
    assert.deepEqual(r, { ok: true, newText: "# Title\n\nHello universe.\n" });
    assert.equal("miss" in r, false);
  });

  it("replace_between success path unchanged (no miss)", () => {
    const original = "a\n## Drop\nold\n## Keep\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Drop",
        endExclusive: "## Keep",
        replace: "## New\nok\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.newText, "a\n## New\nok\n## Keep\n");
    assert.equal("miss" in r, false);
  });
});

describe("applyFileHunks — replace_between normalize parity", () => {
  it("matches start with trailing spaces via normalization", () => {
    // File has clean heading; model sent trailing spaces on start
    const original = "## Section\nbody\n## Next\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Section  ",
        endExclusive: "## Next",
        replace: "## Section\nnew body\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.newText, "## Section\nnew body\n## Next\n");
  });

  it("matches start with CRLF via normalization", () => {
    const original = "## Section\nbody\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Section\r\n",
        replace: "## Section\nfixed\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.newText, "## Section\nfixed\n");
  });

  it("matches endExclusive with trailing whitespace via normalization", () => {
    const original = "## A\nmiddle\n## B\nafter\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## A",
        endExclusive: "## B  ",
        replace: "## A\nnew\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.newText, "## A\nnew\n## B\nafter\n");
  });

  it("still fails closed when normalized start matches multiple times", () => {
    // Exact start not found; normalized would match 2x → stay not-found (parity with replace)
    const original = "## Sec\none\n## Sec\ntwo\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Sec  ",
        replace: "x",
      },
    ]);
    // normalized "## Sec" matches twice → normalize only accepts unique, so not_found
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.miss?.kind, "start_not_found");
  });

  it("exact multi-match start still fails as start_not_unique (fail-closed)", () => {
    const r = applyFileHunks("x## Sec\ny## Sec\n", [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Sec",
        replace: "z",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.miss?.kind, "start_not_unique");
    assert.equal(r.miss?.matchCount, 2);
  });
});

describe("applyHunks — propagates miss", () => {
  it("includes miss on multi-file dispatch failure", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.md", search: "MISSING", replace: "X" },
    ];
    const r = applyHunks({ "a.md": "content" }, hunks);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /^file "a.md":/);
    assert.ok(r.miss);
    assert.equal(r.miss!.kind, "search_not_found");
    assert.equal(r.miss!.file, "a.md");
    // miss.message keeps the unprefixed applyFileHunks error
    assert.match(r.miss!.message, /hunk\[0\]/);
    assert.doesNotMatch(r.miss!.message, /^file "/);
  });

  it("success multi-file has no miss", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.md", search: "A1", replace: "A2" },
    ];
    const r = applyHunks({ "a.md": "A1 text" }, hunks);
    assert.deepEqual(r, {
      ok: true,
      newTextsByFile: { "a.md": "A2 text" },
    });
  });
});

describe("NEARBY_LINE_RADIUS constant", () => {
  it("defaults to 5", () => {
    assert.equal(NEARBY_LINE_RADIUS, 5);
  });
});
