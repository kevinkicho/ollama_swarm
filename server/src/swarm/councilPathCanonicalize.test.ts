import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeExpectedFiles } from "./councilPathCanonicalize.js";

test("canonicalizeExpectedFiles — single path unchanged", () => {
  assert.deepEqual(
    canonicalizeExpectedFiles(["readme.md"], ["readme.md"]),
    ["readme.md"],
  );
});

test("canonicalizeExpectedFiles — collapses docs/ + root duplicate basename", () => {
  const repo = ["synthesis_methods.md", "docs/synthesis_methods.md"];
  const got = canonicalizeExpectedFiles(
    ["docs/synthesis_methods.md", "synthesis_methods.md"],
    repo,
  );
  assert.deepEqual(got, ["synthesis_methods.md"]);
});

test("canonicalizeExpectedFiles — prefers in-repo path when only one exists", () => {
  const got = canonicalizeExpectedFiles(
    ["docs/missing.md", "present.md"],
    ["docs/missing.md"],
  );
  assert.deepEqual(got, ["docs/missing.md", "present.md"]);
});