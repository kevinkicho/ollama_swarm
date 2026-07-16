import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildApplyMissReport,
  buildNearbyExcerpt,
  computeUniqueCandidates,
  expandToUnique,
  findUniqueSubstrings,
  lineIndexAtOffset,
  normalizeSearchWhitespace,
  truncateForReport,
  EXPAND_MAX_LINES,
  NEARBY_EXCERPT_MAX_CHARS,
  NEARBY_LINE_RADIUS,
  UNIQUE_CANDIDATE_MAX,
  UNIQUE_CANDIDATE_MIN_LENGTH,
} from "./applyMissReport.js";
import { applyFileHunks, applyHunks, type Hunk } from "./applyHunks.js";

/**
 * Multi-section fixture shaped like eee6718f panelRegistry keys: shared
 * structural lines appear twice; each section has a unique body line.
 */
const PANEL_REGISTRY_FIXTURE = `export const panels = {
  rates: {
    id: "panel-rates-dashboard-key",
    title: "Interest Rates Shared Title Line XXX",
    body: "section rates unique content for panel rates",
  },
  // section
  fx: {
    id: "panel-fx-dashboard-key-xx",
    title: "Interest Rates Shared Title Line XXX",
    body: "section fx unique content here for panel fx",
  },
};
`;

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

describe("findUniqueSubstrings", () => {
  it("returns [] when needle has no unique substrings in file", () => {
    assert.deepEqual(
      findUniqueSubstrings("zzzz-not-present-at-all-xxxxxxxxxx", "alpha\nbeta\n"),
      [],
    );
  });

  it("returns [] for empty needle or file", () => {
    assert.deepEqual(findUniqueSubstrings("", "hello"), []);
    assert.deepEqual(findUniqueSubstrings("hello world enough length xx", ""), []);
  });

  it("finds unique line from needle that appears once (panelRegistry shape)", () => {
    // Needle mixes a duplicated title line with a unique body line; only the
    // unique body (or its long prefixes/suffixes) should surface.
    const uniqueBody = "    body: \"section rates unique content for panel rates\",";
    assert.ok(uniqueBody.length >= UNIQUE_CANDIDATE_MIN_LENGTH);
    const needle = [
      '    title: "Interest Rates Shared Title Line XXX",',
      uniqueBody,
      "    ghost: \"not present in the file content at all\",",
    ].join("\n");

    const cands = findUniqueSubstrings(needle, PANEL_REGISTRY_FIXTURE);
    assert.ok(cands.length >= 1, `expected candidates, got ${JSON.stringify(cands)}`);
    assert.ok(
      cands.some((c) => c.includes("section rates unique content")),
      `expected rates body in candidates: ${JSON.stringify(cands)}`,
    );
    // Shared title appears twice — full title line must not be a candidate.
    for (const c of cands) {
      assert.notEqual(
        c,
        '    title: "Interest Rates Shared Title Line XXX",',
      );
      // Every candidate must appear exactly once.
      assert.equal(
        PANEL_REGISTRY_FIXTURE.split(c).length - 1,
        1,
        `candidate not unique: ${c}`,
      );
    }
  });

  it("prefers longer candidates and caps at UNIQUE_CANDIDATE_MAX", () => {
    // One long unique line — prefixes/suffixes also unique; cap applies.
    const unique =
      "UNIQUE_LINE_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_EXTRA_TAIL";
    const fileText = `head\n${unique}\ntail\n`;
    const cands = findUniqueSubstrings(unique, fileText);
    assert.ok(cands.length >= 1);
    assert.ok(cands.length <= UNIQUE_CANDIDATE_MAX);
    // Longest first
    for (let i = 1; i < cands.length; i++) {
      assert.ok(cands[i - 1]!.length >= cands[i]!.length);
    }
  });

  it("respects minLength (default 32)", () => {
    const short = "short-unique-but-under-32"; // 25 chars
    const fileText = `aaa\n${short}\nbbb\n`;
    assert.deepEqual(findUniqueSubstrings(short, fileText), []);
    // With lower minLength the full string (and its unique prefixes/suffixes) appear.
    const cands = findUniqueSubstrings(short, fileText, 10);
    assert.ok(cands.includes(short));
    assert.ok(cands.every((c) => c.length >= 10));
    assert.ok(cands.length <= UNIQUE_CANDIDATE_MAX);
  });
});

describe("expandToUnique", () => {
  it("returns [] when start is already unique or absent", () => {
    const file = "only once here\nother\n";
    assert.deepEqual(expandToUnique("only once here", file), []);
    assert.deepEqual(expandToUnique("missing", file), []);
  });

  it("expands multi-match start with surrounding lines until unique", () => {
    // Shared title appears twice; expand with body line → unique.
    const start = '    title: "Interest Rates Shared Title Line XXX",';
    assert.ok(
      PANEL_REGISTRY_FIXTURE.split(start).length - 1 === 2,
      "fixture should have 2 title matches",
    );
    const cands = expandToUnique(start, PANEL_REGISTRY_FIXTURE);
    assert.ok(cands.length >= 1, `expected expand candidates, got ${JSON.stringify(cands)}`);
    // First match is rates section — expansion should include rates body.
    assert.ok(
      cands.some((c) => c.includes("section rates unique content")),
      `expected rates context: ${JSON.stringify(cands)}`,
    );
    for (const c of cands) {
      assert.equal(PANEL_REGISTRY_FIXTURE.split(c).length - 1, 1);
      assert.ok(c.includes(start) || c.includes("title:"));
    }
  });

  it("returns [] when expansion still not unique within maxExpandLines", () => {
    // Entire 3-line block duplicated — no unique expansion within budget.
    const block = [
      "DUP_LINE_AAAAAAAA_0123456789_XXXX",
      "DUP_LINE_BBBBBBBB_0123456789_XXXX",
      "DUP_LINE_CCCCCCCC_0123456789_XXXX",
    ].join("\n");
    const fileText = `${block}\n---\n${block}\n`;
    const start = "DUP_LINE_AAAAAAAA_0123456789_XXXX";
    const cands = expandToUnique(start, fileText, 1); // only 1 line expand — still duplicated
    assert.deepEqual(cands, []);
  });

  it("defaults maxExpandLines to EXPAND_MAX_LINES (5)", () => {
    assert.equal(EXPAND_MAX_LINES, 5);
  });
});

describe("computeUniqueCandidates", () => {
  it("search_not_found / start_not_found use findUniqueSubstrings", () => {
    const uniqueBody = "    body: \"section fx unique content here for panel fx\",";
    const needle = `missing-top\n${uniqueBody}`;
    const a = computeUniqueCandidates("search_not_found", needle, PANEL_REGISTRY_FIXTURE);
    const b = computeUniqueCandidates("start_not_found", needle, PANEL_REGISTRY_FIXTURE);
    assert.deepEqual(a, b);
    assert.ok(a.some((c) => c.includes("section fx unique")));
  });

  it("start_not_unique / search_not_unique use expandToUnique", () => {
    const start = '    title: "Interest Rates Shared Title Line XXX",';
    const a = computeUniqueCandidates("start_not_unique", start, PANEL_REGISTRY_FIXTURE);
    const b = computeUniqueCandidates("search_not_unique", start, PANEL_REGISTRY_FIXTURE);
    assert.deepEqual(a, b);
    assert.ok(a.length >= 1);
  });

  it("other / end_not_found return []", () => {
    assert.deepEqual(
      computeUniqueCandidates("other", "anything long enough here yes", PANEL_REGISTRY_FIXTURE),
      [],
    );
    assert.deepEqual(
      computeUniqueCandidates("end_not_found", "anything long enough here yes", PANEL_REGISTRY_FIXTURE),
      [],
    );
  });
});

describe("buildApplyMissReport", () => {
  it("truncates needle and leaves uniqueCandidates empty when none match", () => {
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

  it("populates uniqueCandidates for search_not_found from file substrings", () => {
    const uniqueBody = "    body: \"section rates unique content for panel rates\",";
    const needle = [
      "NOT_IN_FILE_PREFIX_XXXXXXXXXXXXXXXX",
      uniqueBody,
    ].join("\n");
    const r = buildApplyMissReport({
      file: "panelRegistry.ts",
      hunkIndex: 0,
      op: "replace",
      kind: "search_not_found",
      needle,
      matchCount: 0,
      fileText: PANEL_REGISTRY_FIXTURE,
      message: "search not found",
    });
    assert.ok(r.uniqueCandidates.length >= 1);
    assert.ok(
      r.uniqueCandidates.some((c) => c.includes("section rates unique")),
    );
  });

  it("populates uniqueCandidates for start_not_unique via expand", () => {
    const start = '    title: "Interest Rates Shared Title Line XXX",';
    const r = buildApplyMissReport({
      file: "panelRegistry.ts",
      hunkIndex: 0,
      op: "replace_between",
      kind: "start_not_unique",
      needle: start,
      matchCount: 2,
      fileText: PANEL_REGISTRY_FIXTURE,
      message: "start matches 2 times",
    });
    assert.ok(r.uniqueCandidates.length >= 1);
    assert.ok(
      r.uniqueCandidates.some((c) => c.includes("section rates unique")),
    );
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
    // Short needle with no file overlap → no candidates
    assert.deepEqual(r.miss!.uniqueCandidates, []);
    assert.equal(r.miss!.message, r.error);
    // File head excerpt when not found
    assert.match(r.miss!.nearbyExcerpt, /# Title/);
    assert.ok(r.miss!.nearbyExcerpt.length <= NEARBY_EXCERPT_MAX_CHARS);
  });

  it("search not unique → kind search_not_unique (still fail-closed)", () => {
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
    // Must NOT silently apply first match
    assert.equal(r.ok, false);
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
    // Short start still expands via surrounding lines when unique
    assert.ok(
      r.miss!.uniqueCandidates.length >= 1,
      `expected expand candidates: ${JSON.stringify(r.miss!.uniqueCandidates)}`,
    );
    assert.ok(r.miss!.uniqueCandidates.some((c) => c.includes("one")));
  });

  it("panelRegistry multi-section: needle with unique body → candidates", () => {
    const uniqueBody =
      "    body: \"section rates unique content for panel rates\",";
    const search = [
      "    NOT_A_REAL_FIELD: true,",
      uniqueBody,
    ].join("\n");
    const r = applyFileHunks(PANEL_REGISTRY_FIXTURE, [
      {
        op: "replace",
        file: "panelRegistry.ts",
        search,
        replace: "x",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.miss!.kind, "search_not_found");
    assert.ok(r.miss!.uniqueCandidates.length >= 1);
    assert.ok(
      r.miss!.uniqueCandidates.some((c) =>
        c.includes("section rates unique content"),
      ),
    );
    // Fail-closed: did not apply
    assert.equal(PANEL_REGISTRY_FIXTURE.includes("section rates"), true);
  });

  it("panelRegistry multi-section: start_not_unique expands, never first-match apply", () => {
    const start = '    title: "Interest Rates Shared Title Line XXX",';
    const r = applyFileHunks(PANEL_REGISTRY_FIXTURE, [
      {
        op: "replace_between",
        file: "panelRegistry.ts",
        start,
        endExclusive: "  },",
        replace: "    title: \"Patched\",\n",
      },
    ]);
    assert.equal(r.ok, false, "must fail-closed on multi-match start");
    if (r.ok) return;
    assert.equal(r.miss!.kind, "start_not_unique");
    assert.equal(r.miss!.matchCount, 2);
    assert.ok(r.miss!.uniqueCandidates.length >= 1);
    assert.ok(
      r.miss!.uniqueCandidates.some((c) =>
        c.includes("section rates unique content"),
      ),
      `candidates: ${JSON.stringify(r.miss!.uniqueCandidates)}`,
    );
    // File text unchanged (no silent first-match)
    assert.equal(
      applyFileHunks(PANEL_REGISTRY_FIXTURE, [
        {
          op: "replace_between",
          file: "panelRegistry.ts",
          start,
          replace: "x",
        },
      ]).ok,
      false,
    );
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

  it("empty start marker → kind other with miss", () => {
    const r = applyFileHunks("hello", [
      {
        op: "replace_between",
        file: "f.md",
        start: "",
        replace: "x",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /empty "start" marker/);
    assert.equal(r.miss?.kind, "other");
    assert.deepEqual(r.miss?.uniqueCandidates, []);
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

  it("matches endExclusive with CRLF via normalization", () => {
    const original = "## A\nmiddle\n## B\nafter\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## A",
        endExclusive: "## B\r\n",
        replace: "## A\nnew\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.newText, "## A\nnew\n## B\nafter\n");
  });

  it("rejects whitespace-only endExclusive that normalizes to empty (fail-closed)", () => {
    // indexOf("", from) always "matches" — must not accept empty normalized end.
    // Repro from review: would otherwise yield ok:true newText="X\n\nline\n## End\n".
    const original = "## Start\nline\n## End\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Start",
        endExclusive: "   ",
        replace: "X\n",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /"endExclusive" text not found after start/);
    assert.equal(r.miss?.kind, "end_not_found");
    assert.equal(r.miss?.needle, "   ");
    assert.deepEqual(r.miss?.uniqueCandidates, []);
  });

  it("rejects tab-only endExclusive that normalizes to empty", () => {
    const r = applyFileHunks("## Start\nbody\n", [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Start",
        endExclusive: "\t",
        replace: "X\n",
      },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.miss?.kind, "end_not_found");
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
