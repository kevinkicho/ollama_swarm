import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  applyFileHunks,
  applyHunks,
  type Hunk,
} from "./applyHunks.js";

describe("applyFileHunks — create path (currentText === null)", () => {
  it("creates a new file with the content from a single create hunk", () => {
    const r = applyFileHunks(null, [
      { op: "create", file: "new.ts", content: "export const x = 1;\n" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "export const x = 1;\n" });
  });

  it("rejects multiple hunks on a non-existent file", () => {
    const r = applyFileHunks(null, [
      { op: "create", file: "new.ts", content: "a" },
      { op: "append", file: "new.ts", content: "b" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /expected exactly one "create" or "write" hunk, got 2/);
  });

  it("rejects a replace op against a non-existent file", () => {
    const r = applyFileHunks(null, [
      { op: "replace", file: "new.ts", search: "foo", replace: "bar" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /expected "create" or "write"/);
  });

  it("creates via write when file is missing", () => {
    const r = applyFileHunks(null, [
      { op: "write", file: "new.ts", content: "export const y = 2;\n" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "export const y = 2;\n" });
  });

  it("rejects an append op against a non-existent file", () => {
    const r = applyFileHunks(null, [
      { op: "append", file: "new.ts", content: "..." },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /expected "create"/);
  });

  it("treats empty hunks array on null as ok with empty newText", () => {
    // Defensive: callers shouldn't ask for zero hunks, but if they do we
    // don't want to spuriously fail or crash.
    const r = applyFileHunks(null, []);
    assert.deepEqual(r, { ok: true, newText: "" });
  });
});

describe("applyFileHunks — replace semantics", () => {
  it("replaces a single unique match", () => {
    const original = "# Title\n\nHello world.\n";
    const r = applyFileHunks(original, [
      { op: "replace", file: "r.md", search: "Hello world.", replace: "Hello universe." },
    ]);
    assert.deepEqual(r, { ok: true, newText: "# Title\n\nHello universe.\n" });
  });

  it("replaces a match that spans multiple lines", () => {
    const original = "alpha\nbeta\ngamma\n";
    const r = applyFileHunks(original, [
      { op: "replace", file: "r.txt", search: "beta\ngamma", replace: "BETA\nGAMMA" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "alpha\nBETA\nGAMMA\n" });
  });

  it("replaces at the very start of the file", () => {
    const r = applyFileHunks("STARTmiddleEND", [
      { op: "replace", file: "r.txt", search: "START", replace: "BEGIN" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "BEGINmiddleEND" });
  });

  it("replaces at the very end of the file", () => {
    const r = applyFileHunks("STARTmiddleEND", [
      { op: "replace", file: "r.txt", search: "END", replace: "FINISH" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "STARTmiddleFINISH" });
  });

  it("allows replacement with empty string (deletion)", () => {
    const r = applyFileHunks("aXXXb", [
      { op: "replace", file: "r.txt", search: "XXX", replace: "" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "ab" });
  });

  it("fails when the search text does not appear in the file", () => {
    const r = applyFileHunks("hello", [
      { op: "replace", file: "r.txt", search: "missing", replace: "found" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /"search" text not found/);
    if (!r.ok) {
      assert.equal(r.miss?.kind, "search_not_found");
      assert.equal(r.miss?.matchCount, 0);
    }
  });

  it("fails when the search text appears more than once (ambiguous anchor)", () => {
    const r = applyFileHunks("foo bar foo baz foo", [
      { op: "replace", file: "r.txt", search: "foo", replace: "X" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /matches 3 times/);
    if (!r.ok) {
      assert.equal(r.miss?.kind, "search_not_unique");
      assert.equal(r.miss?.matchCount, 3);
    }
  });

  it("reports which hunk index failed when there are several", () => {
    const r = applyFileHunks("aaa bbb ccc", [
      { op: "replace", file: "r.txt", search: "aaa", replace: "A" },
      { op: "replace", file: "r.txt", search: "MISSING", replace: "?" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /hunk\[1\]/);
  });

  it("does not require a trailing newline in search or replace", () => {
    const r = applyFileHunks("line1\nline2", [
      { op: "replace", file: "r.txt", search: "line2", replace: "LINE2" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "line1\nLINE2" });
  });
});

describe("applyFileHunks — append semantics", () => {
  it("appends to the end of an existing file verbatim", () => {
    const r = applyFileHunks("# CHANGELOG\n", [
      { op: "append", file: "CHANGELOG.md", content: "\n## 0.2\n- Added thing\n" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "# CHANGELOG\n\n## 0.2\n- Added thing\n" });
  });

  it("does not add or trim whitespace — the worker controls exact bytes", () => {
    const r = applyFileHunks("no-newline-at-end", [
      { op: "append", file: "f.txt", content: "X" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "no-newline-at-endX" });
  });

  it("appends multiple times sequentially", () => {
    const r = applyFileHunks("a", [
      { op: "append", file: "f.txt", content: "b" },
      { op: "append", file: "f.txt", content: "c" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "abc" });
  });
});

describe("applyFileHunks — create on existing file is rejected", () => {
  it("fails a create hunk when the file already has content", () => {
    const r = applyFileHunks("existing", [
      { op: "create", file: "f.txt", content: "new" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /file already exists/);
    if (!r.ok) {
      assert.equal(r.miss?.kind, "other");
      assert.deepEqual(r.miss?.uniqueCandidates, []);
    }
  });

  it("fails create even in a mixed batch (before any successful op applies)", () => {
    const r = applyFileHunks("existing", [
      { op: "replace", file: "f.txt", search: "existing", replace: "updated" },
      { op: "create", file: "f.txt", content: "nope" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /hunk\[1\].*file already exists/);
    if (!r.ok) {
      assert.equal(r.miss?.kind, "other");
    }
  });
});

describe("applyFileHunks — sequential application (each hunk sees prior output)", () => {
  it("second replace can target text produced by the first", () => {
    const r = applyFileHunks("stage1", [
      { op: "replace", file: "f.txt", search: "stage1", replace: "stage2" },
      { op: "replace", file: "f.txt", search: "stage2", replace: "stage3" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "stage3" });
  });

  it("replace followed by append composes as expected", () => {
    const r = applyFileHunks("hello", [
      { op: "replace", file: "f.txt", search: "hello", replace: "HELLO" },
      { op: "append", file: "f.txt", content: "\nworld" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "HELLO\nworld" });
  });

  it("first-hunk success is rolled back when a later hunk fails (caller gets error)", () => {
    // Sequential apply means the mutation is internal to this call — caller
    // never sees the partially-applied text on error, because we return the
    // error branch. The runner should not proceed to write anything.
    const r = applyFileHunks("foo", [
      { op: "replace", file: "f.txt", search: "foo", replace: "bar" },
      { op: "replace", file: "f.txt", search: "foo", replace: "baz" }, // no longer matches
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /hunk\[1\].*not found/);
  });
});

describe("applyHunks — multi-file dispatch", () => {
  it("groups hunks by file and applies each independently", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.md", search: "A1", replace: "A2" },
      { op: "replace", file: "b.md", search: "B1", replace: "B2" },
    ];
    const r = applyHunks({ "a.md": "A1 text", "b.md": "B1 text" }, hunks);
    assert.deepEqual(r, {
      ok: true,
      newTextsByFile: { "a.md": "A2 text", "b.md": "B2 text" },
    });
  });

  it("handles multiple hunks against the same file sequentially", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.md", search: "x", replace: "y" },
      { op: "append", file: "a.md", content: "z" },
    ];
    const r = applyHunks({ "a.md": "xxx" }, hunks);
    // First replace targets "x" but matches 3 times — should fail
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /file "a.md".*matches 3 times/);
  });

  it("returns empty output for zero hunks", () => {
    const r = applyHunks({ "a.md": "x" }, []);
    assert.deepEqual(r, { ok: true, newTextsByFile: {} });
  });

  it("rejects hunks targeting files not in the current-text map", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "unknown.md", search: "x", replace: "y" },
    ];
    const r = applyHunks({ "known.md": "x" }, hunks);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /"unknown.md".*not provided/);
  });

  it("propagates per-file errors with a file prefix for debuggability", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.md", search: "MISSING", replace: "X" },
    ];
    const r = applyHunks({ "a.md": "content" }, hunks);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /^file "a.md":/);
  });

  it("only emits output for files that actually had hunks", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.md", search: "A", replace: "X" },
    ];
    const r = applyHunks({ "a.md": "A", "b.md": "untouched" }, hunks);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(Object.keys(r.newTextsByFile), ["a.md"]);
    }
  });

  it("supports create for new files mixed with replace on existing ones", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "old.md", search: "foo", replace: "bar" },
      { op: "create", file: "new.md", content: "hello\n" },
    ];
    const r = applyHunks({ "old.md": "foo", "new.md": null }, hunks);
    assert.deepEqual(r, {
      ok: true,
      newTextsByFile: { "old.md": "bar", "new.md": "hello\n" },
    });
  });

  // Fuzzy matching: trailing whitespace normalization
  it("matches search with trailing spaces via normalization", () => {
    // File has "hello\n" (no trailing spaces), hunk search has "hello  \n" (trailing spaces)
    const hunks: Hunk[] = [{ op: "replace", file: "a.txt", search: "hello  \n", replace: "hi\n" }];
    const r = applyHunks({ "a.txt": "hello\nworld\n" }, hunks);
    assert.equal(r.ok, true);
  });

  it("matches search with tab-to-space conversion via normalization", () => {
    // File uses spaces, hunk search uses tabs (trimEnd normalizes trailing chars)
    const hunks: Hunk[] = [{ op: "replace", file: "a.txt", search: "hello\t\n", replace: "hi\n" }];
    const r = applyHunks({ "a.txt": "hello\nworld\n" }, hunks);
    assert.equal(r.ok, true);
  });

  it("rejects normalized search when it would produce multi-match", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.txt", search: "dup  \n", replace: "fixed\n" },
    ];
    // Normalized search produces 2 matches, so it's rejected (ambiguous)
    const r = applyHunks({ "a.txt": "dup\ndup\n" }, hunks);
    assert.equal(r.ok, false);
  });

  it("falls through to error when normalized search also not found", () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.txt", search: "nonexistent  \n", replace: "x\n" },
    ];
    const r = applyHunks({ "a.txt": "hello\n" }, hunks);
    assert.equal(r.ok, false);
    assert.ok((r as any).error?.includes("not found"));
  });

  it("exact match still works correctly (regression guard)", () => {
    const hunks: Hunk[] = [{ op: "replace", file: "a.txt", search: "hello", replace: "hi" }];
    const r = applyHunks({ "a.txt": "hello world" }, hunks);
    assert.equal(r.ok, true);
  });

  it("normalization is identity when search is already clean", () => {
    // Clean search — normalization should be a no-op
    const hunks: Hunk[] = [{ op: "replace", file: "a.txt", search: "hello\n", replace: "hi\n" }];
    const r = applyHunks({ "a.txt": "hello\nworld\n" }, hunks);
    assert.equal(r.ok, true);
  });
});

describe("applyFileHunks — write and replace_between", () => {
  it("write replaces entire existing file body", () => {
    const r = applyFileHunks("old entire body\nline2\n", [
      { op: "write", file: "f.md", content: "# New\n" },
    ]);
    assert.deepEqual(r, { ok: true, newText: "# New\n" });
  });

  it("replace_between replaces from start through endExclusive (exclusive)", () => {
    const original = [
      "# Head",
      "",
      "## Keep Me",
      "intro",
      "",
      "## Council Decision Package",
      "fake stuff",
      "more fake",
      "",
      "## 5-Year Plan",
      "later",
      "",
    ].join("\n");
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "roadmap.md",
        start: "## Council Decision Package",
        endExclusive: "## 5-Year Plan",
        replace: "## Manufacturing roadmap\nreal plan\n\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.newText, /## Keep Me/);
    assert.match(r.newText, /## Manufacturing roadmap/);
    assert.match(r.newText, /## 5-Year Plan/);
    assert.doesNotMatch(r.newText, /fake stuff/);
  });

  it("replace_between without endExclusive replaces through EOF", () => {
    const r = applyFileHunks("a\n## Drop\nold\n", [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Drop",
        replace: "## New\nok\n",
      },
    ]);
    assert.deepEqual(r, { ok: true, newText: "a\n## New\nok\n" });
  });

  it("replace_between fails when start is missing", () => {
    const r = applyFileHunks("hello", [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Missing",
        replace: "x",
      },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /"start" text not found/);
    if (!r.ok) {
      assert.equal(r.miss?.kind, "start_not_found");
    }
  });

  it("replace_between normalizes trailing spaces on start (parity with replace)", () => {
    const original = "## Head\nbody\n";
    const r = applyFileHunks(original, [
      {
        op: "replace_between",
        file: "f.md",
        start: "## Head  ",
        replace: "## Head\nnew\n",
      },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.newText, "## Head\nnew\n");
    }
  });
});
