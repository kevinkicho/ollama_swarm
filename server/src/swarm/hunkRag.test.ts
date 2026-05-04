// Q11 (2026-05-04): tests for hunk placement RAG helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  jaccardSimilarity,
  selectSimilarHunks,
  buildHunkRagPromptBlock,
  type PastHunkExample,
} from "./hunkRag.js";

test("tokenize — lowercases + splits non-alphanum", () => {
  const got = tokenize("Add Null-Guard to formatUser() in src/utils.ts");
  assert.ok(got.has("add"));
  assert.ok(got.has("null"));
  assert.ok(got.has("guard"));
  assert.ok(got.has("formatuser"));
  assert.ok(got.has("src"));
  assert.ok(got.has("utils"));
});

test("tokenize — drops stop words", () => {
  const got = tokenize("the quick brown fox is jumping");
  assert.equal(got.has("the"), false);
  assert.equal(got.has("is"), false);
  assert.ok(got.has("quick"));
  assert.ok(got.has("brown"));
});

test("tokenize — drops short tokens (<3 chars)", () => {
  const got = tokenize("a bc def gh ij");
  assert.equal(got.has("a"), false);
  assert.equal(got.has("bc"), false);
  assert.ok(got.has("def"));
  assert.equal(got.has("gh"), false);
});

test("jaccardSimilarity — identical sets → 1", () => {
  const a = new Set(["x", "y", "z"]);
  assert.equal(jaccardSimilarity(a, a), 1);
});

test("jaccardSimilarity — disjoint sets → 0", () => {
  assert.equal(jaccardSimilarity(new Set(["a"]), new Set(["b"])), 0);
});

test("jaccardSimilarity — half-overlap", () => {
  // {a,b} vs {b,c}: intersection={b}, union={a,b,c} → 1/3
  const got = jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]));
  assert.ok(Math.abs(got - 1 / 3) < 0.001);
});

test("jaccardSimilarity — both empty → 0 (defensive)", () => {
  assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
});

test("selectSimilarHunks — picks most similar by token overlap", () => {
  const candidates: PastHunkExample[] = [
    {
      todoDescription: "rename fooBar to barFoo",
      expectedFiles: ["src/foo.ts"],
      hunkResponse: "rename hunk",
    },
    {
      todoDescription: "add null guard to formatUser",
      expectedFiles: ["src/utils.ts"],
      hunkResponse: "null-guard hunk",
    },
    {
      todoDescription: "add null guard to validateInput",
      expectedFiles: ["src/utils.ts"],
      hunkResponse: "validate hunk",
    },
  ];
  const got = selectSimilarHunks({
    query: {
      description: "add null guard to formatAddress",
      expectedFiles: ["src/utils.ts"],
    },
    candidates,
  });
  // Both null-guard candidates should rank above the rename one
  assert.ok(got.length >= 1);
  assert.match(got[0].example.todoDescription, /null guard/);
});

test("selectSimilarHunks — caps at maxResults", () => {
  const candidates: PastHunkExample[] = Array.from({ length: 10 }, (_, i) => ({
    todoDescription: `add null guard ${i}`,
    expectedFiles: ["src/utils.ts"],
    hunkResponse: `hunk ${i}`,
  }));
  const got = selectSimilarHunks({
    query: { description: "add null guard new", expectedFiles: ["src/utils.ts"] },
    candidates,
    maxResults: 2,
  });
  assert.equal(got.length, 2);
});

test("selectSimilarHunks — filters out below minSimilarity", () => {
  const candidates: PastHunkExample[] = [
    {
      todoDescription: "completely unrelated docs change",
      expectedFiles: ["docs/x.md"],
      hunkResponse: "doc edit",
    },
  ];
  const got = selectSimilarHunks({
    query: {
      description: "add null guard to formatUser",
      expectedFiles: ["src/utils.ts"],
    },
    candidates,
    minSimilarity: 0.5,
  });
  assert.equal(got.length, 0);
});

test("selectSimilarHunks — empty candidates → []", () => {
  const got = selectSimilarHunks({
    query: { description: "x", expectedFiles: [] },
    candidates: [],
  });
  assert.deepEqual(got, []);
});

test("buildHunkRagPromptBlock — empty examples → empty string", () => {
  assert.equal(buildHunkRagPromptBlock([]), "");
});

test("buildHunkRagPromptBlock — renders examples with similarity + todo + response", () => {
  const block = buildHunkRagPromptBlock([
    {
      example: {
        todoDescription: "add null guard to fooBar",
        expectedFiles: ["src/x.ts"],
        hunkResponse: 'op: replace\nfile: src/x.ts',
      },
      similarity: 0.42,
    },
  ]);
  assert.match(block, /Few-shot: similar hunks from past successful runs/);
  assert.match(block, /similarity 0\.42/);
  assert.match(block, /add null guard to fooBar/);
  assert.match(block, /op: replace/);
});

test("buildHunkRagPromptBlock — truncates very long hunk responses", () => {
  const longHunk = "x".repeat(5000);
  const block = buildHunkRagPromptBlock([
    {
      example: {
        todoDescription: "x",
        expectedFiles: [],
        hunkResponse: longHunk,
      },
      similarity: 0.5,
    },
  ]);
  // Response should be capped at ~1500 chars
  const xCount = (block.match(/x/g) || []).length;
  assert.ok(xCount <= 1600, `expected ~1500, got ${xCount}`);
});
