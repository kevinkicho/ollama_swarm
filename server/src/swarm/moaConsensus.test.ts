import { test } from "node:test";
import assert from "node:assert/strict";
import { jaccardSimilarity, detectConvergence, pickMostCentralAggregator } from "./moaConsensus.js";

test("jaccardSimilarity — identical strings = 1", () => {
  assert.equal(jaccardSimilarity("the quick brown fox", "the quick brown fox"), 1);
});

test("jaccardSimilarity — completely disjoint = 0", () => {
  assert.equal(jaccardSimilarity("apple banana cherry", "xylophone yacht zebra"), 0);
});

test("jaccardSimilarity — partial overlap is between 0 and 1", () => {
  // {the, quick, brown, fox} ∩ {the, slow, brown, dog} = {the, brown}
  // union = {the, quick, brown, fox, slow, dog}; 2/6 ≈ 0.333
  const sim = jaccardSimilarity("the quick brown fox", "the slow brown dog");
  assert.ok(sim > 0.3 && sim < 0.4, `expected ~0.333, got ${sim}`);
});

test("jaccardSimilarity — case-insensitive", () => {
  assert.equal(jaccardSimilarity("Hello World", "hello world"), 1);
});

test("jaccardSimilarity — punctuation ignored", () => {
  assert.equal(jaccardSimilarity("hello, world!", "hello world"), 1);
});

test("jaccardSimilarity — both empty = 1 (trivially identical)", () => {
  assert.equal(jaccardSimilarity("", ""), 1);
});

test("jaccardSimilarity — one empty = 0", () => {
  assert.equal(jaccardSimilarity("hello", ""), 0);
  assert.equal(jaccardSimilarity("", "hello"), 0);
});

test("jaccardSimilarity — single-char tokens dropped (too noisy)", () => {
  // Tokenizer drops length<2 tokens. "I a" tokenizes to {} so empty.
  assert.equal(jaccardSimilarity("I a", "I a"), 1, "both empty after drop = trivially identical");
  // "I am here" → {am, here}; "you are here" → {you, are, here}
  // Intersect = {here} = 1; union = {am, here, you, are} = 4; 1/4 = 0.25
  assert.equal(jaccardSimilarity("I am here", "you are here"), 0.25);
});

test("detectConvergence — same text → converged=true at default threshold 0.7", () => {
  const v = detectConvergence("the report says X", "the report says X");
  assert.equal(v.converged, true);
  assert.equal(v.similarity, 1);
});

test("detectConvergence — disjoint texts → converged=false", () => {
  const v = detectConvergence("apple banana cherry", "xylophone yacht zebra");
  assert.equal(v.converged, false);
});

test("detectConvergence — borderline 0.7 case", () => {
  // Build a known similarity ≥ 0.7 case
  const a = "the quick brown fox jumps";
  const b = "the quick brown fox runs";
  // {the, quick, brown, fox, jumps} vs {the, quick, brown, fox, runs}
  // intersect=4, union=6, 4/6 ≈ 0.667 — JUST below 0.7
  const v = detectConvergence(a, b);
  assert.ok(v.similarity > 0.6 && v.similarity < 0.7);
  assert.equal(v.converged, false);
});

test("detectConvergence — custom threshold", () => {
  const v = detectConvergence("the quick brown fox jumps", "the quick brown fox runs", 0.5);
  assert.equal(v.converged, true, "0.667 > 0.5");
});

test("pickMostCentralAggregator — single candidate is its own winner", () => {
  const r = pickMostCentralAggregator(["only one"]);
  assert.equal(r.winnerIdx, 0);
  assert.equal(r.meanSimilarity, 1);
  assert.deepEqual(r.perCandidateMean, [1]);
});

test("pickMostCentralAggregator — outlier loses to two-similar-pair winner", () => {
  // c0 + c1 are similar; c2 is the outlier. Either c0 or c1 should win.
  const r = pickMostCentralAggregator([
    "the report concludes the swarm beats baseline",
    "the report shows the swarm beats baseline",
    "i think we should rewrite the entire orchestrator and start over",
  ]);
  assert.notEqual(r.winnerIdx, 2, "outlier shouldn't win");
  // Winner should be c0 or c1 (similar pair)
  assert.ok(r.winnerIdx === 0 || r.winnerIdx === 1);
});

test("pickMostCentralAggregator — ties resolved to lowest index (deterministic)", () => {
  // All three identical — every pair is sim=1; means all = 1; lowest idx wins.
  const r = pickMostCentralAggregator(["same", "same", "same"]);
  assert.equal(r.winnerIdx, 0);
});

test("pickMostCentralAggregator — empty array throws", () => {
  assert.throws(() => pickMostCentralAggregator([]), /must be non-empty/);
});

test("pickMostCentralAggregator — perCandidateMean has one entry per candidate", () => {
  const r = pickMostCentralAggregator(["a b c", "a b d", "a b e"]);
  assert.equal(r.perCandidateMean.length, 3);
});
