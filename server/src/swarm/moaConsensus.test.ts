import { test } from "node:test";
import assert from "node:assert/strict";
import { jaccardSimilarity, detectConvergence, pickMostCentralAggregator, thresholdForDeliverableShape } from "./moaConsensus.js";

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

// 2026-05-02 (matrix row #5): per-task-class convergence thresholds.
test("thresholdForDeliverableShape — analysis tasks default to 0.7", () => {
  assert.equal(thresholdForDeliverableShape("audit list"), 0.7);
  assert.equal(thresholdForDeliverableShape("README analysis"), 0.7);
  assert.equal(thresholdForDeliverableShape("static analysis report"), 0.7);
});

test("thresholdForDeliverableShape — decision/debate tasks default to 0.4 (resist convergence)", () => {
  assert.equal(thresholdForDeliverableShape("architectural decision memo"), 0.4);
  assert.equal(thresholdForDeliverableShape("debate verdict"), 0.4);
});

test("thresholdForDeliverableShape — exploration sits in the middle (0.5)", () => {
  assert.equal(thresholdForDeliverableShape("novel exploration of options"), 0.5);
});

test("thresholdForDeliverableShape — falls back to 0.7 for unknown shapes", () => {
  assert.equal(thresholdForDeliverableShape("unrecognized shape"), 0.7);
  assert.equal(thresholdForDeliverableShape(undefined), 0.7);
  assert.equal(thresholdForDeliverableShape(""), 0.7);
});

test("thresholdForDeliverableShape — case-insensitive on the keyword match", () => {
  assert.equal(thresholdForDeliverableShape("DEBATE on the merits"), 0.4);
  assert.equal(thresholdForDeliverableShape("Decision Document"), 0.4);
});

// 2026-05-02 (issue #1 fix): challenger substantiveness scoring.
import { scoreChallengerSubstantiveness } from "./moaConsensus.js";

test("scoreChallengerSubstantiveness — substantive when challenger raises unique points kept by synthesis", () => {
  const r = scoreChallengerSubstantiveness({
    challengerDraft: "the auth flow has a race condition between token refresh and request retry",
    otherDrafts: [
      "the auth flow needs caching for performance",
      "the auth flow validates tokens correctly",
    ],
    synthesis: "the auth flow needs caching but also has a race condition between token refresh and request retry",
  });
  assert.ok(r.ratio !== null);
  assert.ok(r.ratio >= 0.3, `expected substantive ratio, got ${r.ratio}`);
  assert.equal(r.bucket, "substantive");
});

test("scoreChallengerSubstantiveness — noise when challenger's unique tokens never reach synthesis", () => {
  const r = scoreChallengerSubstantiveness({
    challengerDraft: "kubernetes manifests helm charts deployment pipeline argocd terraform vault consul nomad packer",
    otherDrafts: [
      "the auth module needs validation rules and clear error responses",
      "the auth module needs caching with proper invalidation strategies",
    ],
    synthesis: "the auth module needs validation rules with clear error responses and caching with proper invalidation",
  });
  assert.ok(r.ratio !== null);
  assert.ok(r.ratio < 0.1, `expected noise ratio (<0.1), got ${r.ratio}`);
  assert.equal(r.bucket, "noise");
});

test("scoreChallengerSubstantiveness — REDUNDANT when challenger says nothing unique", () => {
  const r = scoreChallengerSubstantiveness({
    challengerDraft: "the auth module needs validation",
    otherDrafts: [
      "the auth module needs validation",
      "the auth module needs caching",
    ],
    synthesis: "the auth module needs validation and caching",
  });
  assert.equal(r.ratio, null);
  assert.equal(r.bucket, "redundant");
});

test("scoreChallengerSubstantiveness — empty challenger draft → REDUNDANT", () => {
  const r = scoreChallengerSubstantiveness({
    challengerDraft: "",
    otherDrafts: ["something"],
    synthesis: "synthesis here",
  });
  assert.equal(r.ratio, null);
  assert.equal(r.bucket, "redundant");
});
