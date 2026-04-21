import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findBomPrefixed, findZeroedFiles } from "./diffValidation.js";

describe("findZeroedFiles", () => {
  it("returns empty when all newText values are non-empty", () => {
    const got = findZeroedFiles(
      [{ file: "a.ts", newText: "hello" }],
      { "a.ts": "old" },
    );
    assert.deepEqual(got, []);
  });

  it("allows an empty newText when the old file did not exist (new empty file)", () => {
    const got = findZeroedFiles(
      [{ file: "a.ts", newText: "" }],
      { "a.ts": null },
    );
    assert.deepEqual(got, []);
  });

  it("allows an empty newText when the old file was already empty", () => {
    const got = findZeroedFiles(
      [{ file: "a.ts", newText: "" }],
      { "a.ts": "" },
    );
    assert.deepEqual(got, []);
  });

  it("flags a diff that zeros a previously non-empty file", () => {
    const got = findZeroedFiles(
      [{ file: "a.ts", newText: "" }],
      { "a.ts": "old content" },
    );
    assert.deepEqual(got, ["a.ts"]);
  });

  it("flags multiple zeroings in one batch", () => {
    const got = findZeroedFiles(
      [
        { file: "a.ts", newText: "" },
        { file: "b.ts", newText: "ok" },
        { file: "c.ts", newText: "" },
      ],
      { "a.ts": "old a", "b.ts": "old b", "c.ts": "old c" },
    );
    assert.deepEqual(got, ["a.ts", "c.ts"]);
  });

  it("preserves diff order in the output", () => {
    const got = findZeroedFiles(
      [
        { file: "z.ts", newText: "" },
        { file: "a.ts", newText: "" },
      ],
      { "z.ts": "old z", "a.ts": "old a" },
    );
    assert.deepEqual(got, ["z.ts", "a.ts"]);
  });
});

describe("findBomPrefixed", () => {
  it("returns empty when no diff starts with U+FEFF", () => {
    const got = findBomPrefixed([
      { file: "a.ts", newText: "hello" },
      { file: "b.ts", newText: "" },
    ]);
    assert.deepEqual(got, []);
  });

  it("flags a diff whose newText begins with U+FEFF", () => {
    const got = findBomPrefixed([{ file: "a.ts", newText: "﻿hi" }]);
    assert.deepEqual(got, ["a.ts"]);
  });

  it("ignores a BOM that appears mid-string", () => {
    // Only leading BOMs break tooling; an interior U+FEFF is a legal codepoint.
    const got = findBomPrefixed([{ file: "a.ts", newText: "hi﻿there" }]);
    assert.deepEqual(got, []);
  });

  it("flags only the BOM-prefixed diffs in a mixed batch", () => {
    const got = findBomPrefixed([
      { file: "a.ts", newText: "clean" },
      { file: "b.ts", newText: "﻿dirty" },
      { file: "c.ts", newText: "﻿also dirty" },
    ]);
    assert.deepEqual(got, ["b.ts", "c.ts"]);
  });
});
