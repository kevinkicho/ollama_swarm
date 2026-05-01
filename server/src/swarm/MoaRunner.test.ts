import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProposerPrompt, buildAggregatorPrompt } from "./MoaRunner.js";

test("buildProposerPrompt — peer-hidden framing + seed + repo files", () => {
  const prompt = buildProposerPrompt({
    seed: "User directive: refactor the auth module",
    repoFiles: ["src/auth.ts", "src/server.ts"],
    readme: "# Test repo",
    priorSynthesis: null,
  });
  assert.match(prompt, /independent agents/i, "must explain peer-hidden framing");
  assert.match(prompt, /CANNOT see what other agents/);
  assert.match(prompt, /User directive: refactor the auth module/);
  assert.match(prompt, /src\/auth\.ts/);
  assert.match(prompt, /src\/server\.ts/);
  assert.match(prompt, /# Test repo/);
  assert.doesNotMatch(prompt, /Prior round's aggregated synthesis/, "round 1 has no prior synthesis");
});

test("buildProposerPrompt — round 2+ includes prior synthesis", () => {
  const prompt = buildProposerPrompt({
    seed: "directive",
    repoFiles: [],
    readme: null,
    priorSynthesis: "Last round we agreed: split auth.ts into 3 files.",
  });
  assert.match(prompt, /Prior round's aggregated synthesis/);
  assert.match(prompt, /split auth\.ts into 3 files/);
});

test("buildProposerPrompt — README truncated to 2000 chars", () => {
  const longReadme = "§".repeat(5000);
  const prompt = buildProposerPrompt({
    seed: "s",
    repoFiles: [],
    readme: longReadme,
    priorSynthesis: null,
  });
  const count = (prompt.match(/§/g) ?? []).length;
  assert.equal(count, 2000, "README must be truncated to 2000 chars");
});

test("buildAggregatorPrompt — synthesis framing + all N proposers visible", () => {
  const prompt = buildAggregatorPrompt({
    seed: "directive: rename a function",
    proposals: [
      { workerId: "agent-1", text: "I'd rename it to fooBar." },
      { workerId: "agent-2", text: "I'd rename it to fooBar." },
      { workerId: "agent-3", text: "I'd rename it to barFoo." },
    ],
  });
  assert.match(prompt, /aggregator/i);
  assert.match(prompt, /Surfaces the points multiple proposers agreed on/);
  assert.match(prompt, /Drops ideas only one proposer mentioned/);
  assert.match(prompt, /directive: rename a function/);
  // All three proposers visible
  assert.match(prompt, /Proposer 1 \(agent-1\)/);
  assert.match(prompt, /Proposer 2 \(agent-2\)/);
  assert.match(prompt, /Proposer 3 \(agent-3\)/);
  assert.match(prompt, /barFoo/);
});

test("buildAggregatorPrompt — proposer text truncated to 4000 chars", () => {
  // Use a sentinel char that doesn't appear in the prompt template so
  // we can count occurrences directly.
  const longProposal = "§".repeat(6000); // section-sign §
  const prompt = buildAggregatorPrompt({
    seed: "s",
    proposals: [{ workerId: "w1", text: longProposal }],
  });
  const count = (prompt.match(/§/g) ?? []).length;
  assert.equal(count, 4000, "proposer text must be truncated to 4000 chars");
});

test("buildAggregatorPrompt — handles 0-proposer edge case (header still says 0)", () => {
  const prompt = buildAggregatorPrompt({ seed: "s", proposals: [] });
  assert.match(prompt, /Proposers \(0\)/);
});

// #93 deeper (2026-05-01): variant-bias tests for multi-aggregator MoA.

test("buildAggregatorPrompt — default variant 'balanced' adds no bias section", () => {
  const prompt = buildAggregatorPrompt({ seed: "s", proposals: [] });
  assert.doesNotMatch(prompt, /Bias toward/);
});

test("buildAggregatorPrompt — variant 'clarity' adds clarity bias", () => {
  const prompt = buildAggregatorPrompt({
    seed: "s",
    proposals: [],
    variantBias: "clarity",
  });
  assert.match(prompt, /Bias toward CLARITY/);
  assert.doesNotMatch(prompt, /Bias toward COMPLETENESS/);
});

test("buildAggregatorPrompt — variant 'completeness' adds completeness bias", () => {
  const prompt = buildAggregatorPrompt({
    seed: "s",
    proposals: [],
    variantBias: "completeness",
  });
  assert.match(prompt, /Bias toward COMPLETENESS/);
});

test("buildAggregatorPrompt — variant 'actionability' adds actionability bias", () => {
  const prompt = buildAggregatorPrompt({
    seed: "s",
    proposals: [],
    variantBias: "actionability",
  });
  assert.match(prompt, /Bias toward ACTIONABILITY/);
});
