// R9 (2026-05-04): tests for semantic-loop detector.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSemanticLoop,
  toTokenSet,
  jaccard,
  DEFAULT_LOOP_WINDOW,
  DEFAULT_LOOP_SIMILARITY,
} from "./semanticLoopDetector.js";

test("toTokenSet — lowercases + tokenizes", () => {
  const got = toTokenSet("Hello, World! Hello again.");
  assert.deepEqual([...got].sort(), ["again", "hello", "world"]);
});

test("toTokenSet — empty string → empty set", () => {
  assert.equal(toTokenSet("").size, 0);
});

test("toTokenSet — punctuation stripped", () => {
  const got = toTokenSet("foo.bar-baz/quux");
  assert.deepEqual([...got].sort(), ["bar", "baz", "foo", "quux"]);
});

test("jaccard — identical sets → 1", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
});

test("jaccard — disjoint → 0", () => {
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
});

test("jaccard — half overlap", () => {
  // {a,b} vs {b,c} → ∩=1, ∪=3 → 1/3
  const got = jaccard(new Set(["a", "b"]), new Set(["b", "c"]));
  assert.ok(Math.abs(got - 1 / 3) < 1e-9);
});

test("jaccard — both empty → 1 (vacuously equal)", () => {
  assert.equal(jaccard(new Set(), new Set()), 1);
});

test("detectSemanticLoop — fewer than window turns → not loop", () => {
  const got = detectSemanticLoop({
    recentTurns: ["foo", "bar"],
    window: 4,
  });
  assert.equal(got.inLoop, false);
  assert.equal(got.windowSize, 2);
});

test("detectSemanticLoop — all-identical turns → loop (sim=1)", () => {
  const got = detectSemanticLoop({
    recentTurns: ["repeat me", "repeat me", "repeat me", "repeat me"],
    window: 4,
  });
  assert.equal(got.inLoop, true);
  assert.equal(got.minPairwiseSimilarity, 1);
});

test("detectSemanticLoop — varied turns → not loop", () => {
  const got = detectSemanticLoop({
    recentTurns: [
      "the quick brown fox jumps over the lazy dog",
      "completely different content with new words entirely",
      "yet another distinct topic emerges from this turn",
      "and a fourth divergent statement breaks the pattern",
    ],
    window: 4,
  });
  assert.equal(got.inLoop, false);
});

test("detectSemanticLoop — window=2 with identical → loop", () => {
  const got = detectSemanticLoop({
    recentTurns: ["abc def", "abc def"],
    window: 2,
  });
  assert.equal(got.inLoop, true);
});

test("detectSemanticLoop — one outlier in window breaks loop", () => {
  const got = detectSemanticLoop({
    recentTurns: [
      "exact same words here",
      "exact same words here",
      "exact same words here",
      "completely different fresh perspective", // outlier
    ],
    window: 4,
  });
  assert.equal(got.inLoop, false);
});

test("detectSemanticLoop — uses last K when more turns supplied", () => {
  const got = detectSemanticLoop({
    recentTurns: [
      "ancient turn that should not count",
      "another ancient one",
      "loop a", // window starts here
      "loop a",
      "loop a",
      "loop a",
    ],
    window: 4,
  });
  assert.equal(got.inLoop, true);
});

test("detectSemanticLoop — threshold respected (low threshold → easier loop)", () => {
  const got = detectSemanticLoop({
    recentTurns: [
      "shared word a",
      "shared word b",
      "shared word c",
      "shared word d",
    ],
    window: 4,
    threshold: 0.4,
  });
  // Each pair shares "shared" + "word" → 2/4 = 0.5 > 0.4
  assert.equal(got.inLoop, true);
});

test("detectSemanticLoop — high threshold rejects loose loops", () => {
  const got = detectSemanticLoop({
    recentTurns: [
      "shared word a",
      "shared word b",
      "shared word c",
      "shared word d",
    ],
    window: 4,
    threshold: 0.9,
  });
  // Each pair sim is 0.5 < 0.9 → no loop
  assert.equal(got.inLoop, false);
});

test("detectSemanticLoop — defaults are exposed", () => {
  assert.equal(DEFAULT_LOOP_WINDOW, 4);
  assert.equal(DEFAULT_LOOP_SIMILARITY, 0.7);
});

test("detectSemanticLoop — window < 2 → never loop", () => {
  const got = detectSemanticLoop({
    recentTurns: ["a", "a", "a"],
    window: 1,
  });
  assert.equal(got.inLoop, false);
});

test("detectSemanticLoop — reason text always populated", () => {
  const cases: Parameters<typeof detectSemanticLoop>[0][] = [
    { recentTurns: [] },
    { recentTurns: ["a", "a", "a", "a"] },
    { recentTurns: ["a", "b", "c", "d"] },
  ];
  for (const c of cases) {
    const got = detectSemanticLoop(c);
    assert.ok(got.reason.length > 0);
  }
});
