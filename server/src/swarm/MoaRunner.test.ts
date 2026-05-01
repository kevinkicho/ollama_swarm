import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildProposerPrompt, buildAggregatorPrompt } from "./MoaRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOA_RUNNER_SRC = readFileSync(join(__dirname, "MoaRunner.ts"), "utf8");

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

// 2026-05-01 regression — Kevin reported MoA agent sidebar status was
// stuck at spawn-time state. Root cause: MoaRunner.runOne had ZERO
// markStatus + emitAgentState calls (other discussion runners have
// 9-13 each). Fixed in commit f8ed703 by wrapping the prompt call in
// try/finally with markStatus(thinking) before + markStatus(ready) in
// finally. These structural tests catch a regression at the source-
// code level — cheaper than mock-based unit tests for a one-line bug
// in an integration-shaped method, and the bug class is "missing
// calls" which structural matching catches well.

test("MoaRunner.runOne — emits markStatus(thinking) before the prompt", () => {
  // Find the runOne method body
  const runOneMatch = MOA_RUNNER_SRC.match(/private async runOne[\s\S]*?\n  \}/);
  assert.ok(runOneMatch, "runOne private method must exist");
  assert.match(runOneMatch[0], /markStatus\([^)]*"thinking"\)/, "must mark thinking before prompt");
  assert.match(runOneMatch[0], /emitAgentState\([^,]+,\s*"thinking"/, "must emitAgentState(thinking) so WS sees the transition");
});

test("MoaRunner.runOne — emits markStatus(ready) in a finally block (fires even on prompt error)", () => {
  const runOneMatch = MOA_RUNNER_SRC.match(/private async runOne[\s\S]*?\n  \}/);
  assert.ok(runOneMatch, "runOne private method must exist");
  const body = runOneMatch[0];
  assert.match(body, /try\s*\{/, "must use try/...");
  assert.match(body, /\}\s*finally\s*\{/, "...finally block so ready state always fires");
  // Make sure the ready emission is inside the finally, not after the try
  const finallyMatch = body.match(/finally\s*\{[\s\S]*?\}\s*$/);
  assert.ok(finallyMatch, "finally block must exist");
  assert.match(finallyMatch[0], /markStatus\([^)]*"ready"\)/, "finally must mark ready");
  assert.match(finallyMatch[0], /emitAgentState\([^,]+,\s*"ready"\)/, "finally must emitAgentState(ready)");
});

test("MoaRunner — emitAgentState helper exists with the right signature", () => {
  // Helper takes (agent, status, thinkingSince?) and emits the
  // {type:"agent_state", agent: AgentState} shape per server/src/types.ts.
  assert.match(
    MOA_RUNNER_SRC,
    /private emitAgentState\(agent: Agent, status: "thinking" \| "ready", thinkingSince\?:/,
    "emitAgentState signature must match the convention used by other runners",
  );
  assert.match(
    MOA_RUNNER_SRC,
    /type: "agent_state",\s*agent:\s*\{/,
    "emitAgentState must emit the {type, agent} shape (not flat fields)",
  );
});
