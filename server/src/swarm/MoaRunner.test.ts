import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildProposerPrompt, buildAggregatorPrompt } from "./moaPromptHelpers.js";
import { pickSelfCritiqueAgent } from "./moaPromptHelpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOA_RUNNER_SRC = readFileSync(join(__dirname, "MoaRunner.ts"), "utf8");
const MOA_LOOP_SRC = readFileSync(join(__dirname, "moaLoopBody.ts"), "utf8");
const MOA_RUN_ONE_SRC = readFileSync(join(__dirname, "moaRunOne.ts"), "utf8");
const ALL_MOA_SRC = [MOA_RUNNER_SRC, MOA_LOOP_SRC, MOA_RUN_ONE_SRC].join("\n");

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
  // Implementation lives in moaRunOne.ts (thin MoaRunner.runOne delegates).
  assert.match(MOA_RUN_ONE_SRC, /markStatus\([^)]*"thinking"\)/, "must mark thinking before prompt");
  assert.match(
    MOA_RUN_ONE_SRC,
    /emitAgent(Status|State)\([^,]+,\s*"thinking"/,
    "must emit agent state/thinking so WS sees the transition",
  );
  assert.match(MOA_RUNNER_SRC, /moaRunOne\(/, "MoaRunner.runOne must delegate to moaRunOne");
});

test("MoaRunner.runOne — emits markStatus(ready) in a finally block (fires even on prompt error)", () => {
  const body = MOA_RUN_ONE_SRC;
  assert.match(body, /try\s*\{/, "must use try/...");
  assert.match(body, /\}\s*finally\s*\{/, "...finally block so ready state always fires");
  const finallyMatch = body.match(/finally\s*\{[\s\S]*?\n  \}/);
  assert.ok(finallyMatch, "finally block must exist");
  assert.match(finallyMatch[0], /markStatus\([^)]*"ready"\)/, "finally must mark ready");
  assert.match(finallyMatch[0], /emitAgent(Status|State)\([^,]+,\s*"ready"\)/, "finally must emit agent state/ready");
});

test("MoaRunner — emitAgentState helper exists with the right signature", () => {
  assert.match(
    MOA_RUNNER_SRC,
    /private emitAgent(Status|State)\(agent: Agent, status: "thinking" \| "ready"(, thinkingSince\?:)?/,
    "emitAgentState/Status signature must match the convention used by other runners",
  );
  assert.match(
    MOA_RUNNER_SRC,
    /this\.emitAgentState\(\{/,
    "emitAgentStatus must delegate to this.emitAgentState (base class) with an AgentState object",
  );
});

// 2026-05-01 regression — Sweep 2 attempt #6 onward read STALE summary.json
// because MoaRunner.loop never wrote one. Every other discussion runner
// (Council, RoundRobin, etc.) wraps loop in try/finally → writeSummary;
// MoA was missing the call entirely. Eval harness reads <clonePath>/summary.json
// to score, so missing writes meant subsequent attempts captured the
// previous run's data (same runId, same wallS). Structural checks at
// the source-code level catch a regression cheaper than mocking the
// whole file-write chain.

test("MoaRunner.loop — wraps body in try/catch/finally that writes summary", () => {
  // Anchor: the public loop method delegates to loopBody and ensures
  // writeSummary fires even on crash.
  const loopMatch = MOA_RUNNER_SRC.match(/private async loop\(cfg: RunConfig\)[\s\S]*?\n  \}/);
  assert.ok(loopMatch, "loop method must exist");
  const body = loopMatch[0];
  assert.match(body, /try\s*\{/, "loop must have try");
  assert.match(body, /\}\s*catch\s*\(/, "loop must catch crashes");
  assert.match(body, /\}\s*finally\s*\{/, "loop must finalize so writeSummary always fires");
  assert.match(body, /this\.writeSummary\(cfg, crashMessage\)/, "finally must call writeSummary");
});

// 2026-05-01 (#119): mid-run user chat must reach proposers + aggregator.
// Pre-fix: MoA injectUser pushed user-role transcript entries but the
// prompt builders never consulted them. Chat went to the UI bubble only.
// This batch confirms userMessages flow through both prompt builders and
// that runOne (in MoaRunner.loop) extracts user-role entries from
// transcript before each round.

test("buildProposerPrompt — userMessages render as [HUMAN] block", () => {
  const prompt = buildProposerPrompt({
    seed: "directive",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
    userMessages: ["focus on auth.ts", "skip refactors"],
  });
  assert.match(prompt, /Recent user .human. messages/i);
  assert.match(prompt, /\[HUMAN\] focus on auth\.ts/);
  assert.match(prompt, /\[HUMAN\] skip refactors/);
});

// 2026-05-02 (lever #3): round 2+ proposers must see prior-round raw
// drafts alongside the synthesis. Pre-fix: only the aggregator's
// compression was visible; nuance from individual proposers was lost.

test("buildProposerPrompt — priorProposals render as a labeled peer block", () => {
  const prompt = buildProposerPrompt({
    seed: "directive",
    repoFiles: [],
    readme: null,
    priorSynthesis: "Compressed gist of round 1.",
    priorProposals: ["draft from peer A", "draft from peer B"],
  });
  assert.match(prompt, /Prior round's individual proposer drafts/);
  assert.match(prompt, /Peer 1 \(round-1 draft\)/);
  assert.match(prompt, /Peer 2 \(round-1 draft\)/);
  assert.match(prompt, /draft from peer A/);
  assert.match(prompt, /draft from peer B/);
});

test("buildProposerPrompt — priorProposals absent renders no peer block", () => {
  const prompt = buildProposerPrompt({
    seed: "directive",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
  });
  assert.doesNotMatch(prompt, /Prior round's individual proposer drafts/);
  assert.doesNotMatch(prompt, /Peer 1 \(round-1 draft\)/);
});

test("buildProposerPrompt — priorProposals truncated to 1500 chars per peer", () => {
  // Cap is per-peer so N proposers don't blow the prompt budget. The
  // synthesis above already carries the gist if the full draft is too
  // long.
  const longDraft = "§".repeat(2500); // 2500 section-sign chars
  const prompt = buildProposerPrompt({
    seed: "s",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
    priorProposals: [longDraft],
  });
  const count = (prompt.match(/§/g) ?? []).length;
  assert.equal(count, 1500, "each peer draft must be truncated to 1500 chars");
});

test("MoaRunner.loop — captures round-N validProposals + threads to round N+1's priorProposals (#3)", () => {
  // Structural: the loop must (a) initialize priorProposals as an
  // empty array before the round loop, (b) populate it from the
  // round's validProposals at the END of each iteration so the NEXT
  // iteration sees them, (c) pass priorProposals to buildProposerPrompt.
  assert.match(
    ALL_MOA_SRC,
    /let priorProposals: string\[\] = \[\]/,
    "loop must initialize priorProposals as empty array",
  );
  assert.match(
    ALL_MOA_SRC,
    /priorProposals = validProposals\.map\(\(p\) => p\.text\)/,
    "end-of-round must capture validProposals' texts into priorProposals",
  );
  assert.match(
    ALL_MOA_SRC,
    /buildProposerPrompt\(\{[\s\S]{0,600}priorProposals,/,
    "buildProposerPrompt call must thread priorProposals",
  );
});

// 2026-05-02 (lever #1): retrieval-augmented context. Pre-fetched
// file excerpts must surface in the proposer prompt for grounding.

test("buildProposerPrompt — repoExcerpts render as labeled file blocks", () => {
  const prompt = buildProposerPrompt({
    seed: "audit the readme",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
    repoExcerpts: [
      { path: "package.json", excerpt: '{"name":"test","version":"1.0.0"}' },
      { path: "src/index.ts", excerpt: 'export const x = 1;' },
    ],
  });
  assert.match(prompt, /Pre-fetched file excerpts/);
  assert.match(prompt, /--- package\.json ---/);
  assert.match(prompt, /--- src\/index\.ts ---/);
  assert.match(prompt, /"name":"test"/);
  assert.match(prompt, /export const x = 1/);
});

test("buildProposerPrompt — repoExcerpts absent renders no excerpt block", () => {
  const prompt = buildProposerPrompt({
    seed: "s",
    repoFiles: ["a.ts"],
    readme: null,
    priorSynthesis: null,
  });
  assert.doesNotMatch(prompt, /Pre-fetched file excerpts/);
});

test("MoaRunner.loop — calls gatherProposerContext and threads to all rounds (#1)", () => {
  // Structural: gather is called BEFORE the round loop (single-shot
  // for cost), and the result threads to buildProposerPrompt.
  assert.match(
    ALL_MOA_SRC,
    /gatherProposerContext\(\{[\s\S]{0,300}clonePath: destPath/,
    "loop must call gatherProposerContext with the clone path",
  );
  assert.match(
    ALL_MOA_SRC,
    /buildProposerPrompt\(\{[\s\S]{0,800}repoExcerpts,/,
    "buildProposerPrompt call must thread repoExcerpts",
  );
});

test("buildProposerPrompt — userMessages absent renders no [HUMAN] block", () => {
  const prompt = buildProposerPrompt({
    seed: "directive",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
  });
  assert.doesNotMatch(prompt, /\[HUMAN\]/);
  assert.doesNotMatch(prompt, /Recent user/);
});

test("buildAggregatorPrompt — userMessages render as [HUMAN] block before proposers", () => {
  const prompt = buildAggregatorPrompt({
    seed: "s",
    proposals: [{ workerId: "w1", text: "draft" }],
    userMessages: ["prefer option A"],
  });
  assert.match(prompt, /\[HUMAN\] prefer option A/);
  // Must precede the proposer block so the aggregator sees user steering
  // before it sees disagreement to reconcile.
  const humanIdx = prompt.indexOf("[HUMAN]");
  const proposerIdx = prompt.indexOf("Proposer 1");
  assert.ok(humanIdx > 0 && proposerIdx > 0 && humanIdx < proposerIdx, "userMessages must render before proposer block");
});

test("MoaRunner.loop — extracts user-role transcript entries before building prompts (#119)", () => {
  // Structural: the per-round loop body must read user-role entries
  // and pass them as `userMessages` to both prompt builders. Otherwise
  // the type field accepts the prop but no real chat reaches the agent.
  assert.match(
    ALL_MOA_SRC,
    /(?:this|host)\.transcript\.filter\(\(e\) => e\.role === "user"\)/,
    "loop must filter transcript for role==='user' entries each round",
  );
  assert.match(
    ALL_MOA_SRC,
    /buildProposerPrompt\(\{[\s\S]{0,800}userMessages,/,
    "buildProposerPrompt call must thread userMessages",
  );
  // 2026-05-02 (chat lever #3): aggregator now uses a per-aggregator
  // filtered list (`aggUserMessages`) for @mention routing — the call
  // site maps to the userMessages prop name via shorthand-disable.
  assert.match(
    ALL_MOA_SRC,
    /buildAggregatorPrompt\(\{[\s\S]{0,400}userMessages: aggUserMessages/,
    "buildAggregatorPrompt call must thread per-aggregator userMessages (lever #3 @mention filter)",
  );
});

// 2026-05-02 (matrix rows #1-#3-#5): structural tests for the new
// quality enhancements. Source-grep style — full integration is
// exercised in the next MoA sweep.

test("buildProposerPrompt — challenger variant produces red-team framing", () => {
  const challenger = buildProposerPrompt({
    seed: "evaluate option X",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
    variant: "challenger",
  });
  assert.match(challenger, /CHALLENGER/);
  assert.match(challenger, /counter-evidence|tradeoffs|failure modes/i);
});

test("buildProposerPrompt — default variant keeps cooperative framing", () => {
  const cooperative = buildProposerPrompt({
    seed: "evaluate option X",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
    variant: "default",
  });
  assert.doesNotMatch(cooperative, /CHALLENGER/);
  assert.match(cooperative, /independent agents|do your own thinking/i);
});

test("buildProposerPrompt — variant defaults to 'default' when omitted", () => {
  const noVariant = buildProposerPrompt({
    seed: "x",
    repoFiles: [],
    readme: null,
    priorSynthesis: null,
  });
  assert.doesNotMatch(noVariant, /CHALLENGER/);
});

test("MoaRunner.loop — designates LAST proposer as challenger when N≥2 (#2)", () => {
  // Structural: the per-proposer build must compute isChallenger from
  // index === proposers.length - 1 AND proposers.length >= 2.
  assert.match(
    ALL_MOA_SRC,
    /isChallenger\s*=\s*proposers\.length >= 2 && idx === proposers\.length - 1/,
    "challenger designation must gate on N≥2 AND last-index",
  );
  assert.match(
    ALL_MOA_SRC,
    /variant: isChallenger \? "challenger" : "default"/,
    "buildProposerPrompt call must pass variant from isChallenger flag",
  );
});

test("MoaRunner — runAggregatorSelfCritique exists with right signature (#3)", () => {
  // Structural: self-critique is a private async method on MoaRunner
  // that takes (agg, synthesis, proposals) and returns the final
  // synthesis (revised or original).
  assert.match(
    MOA_RUNNER_SRC,
    /private async runAggregatorSelfCritique\(\s*agg: Agent,\s*synthesis: string,\s*proposals: ReadonlyArray</,
    "runAggregatorSelfCritique signature must match the convention",
  );
  // The synthesis variable in the loop body must be reassigned from
  // the self-critique result so a REVISE actually replaces the original.
  assert.match(
    ALL_MOA_SRC,
    /synthesis = await (?:this|host)\.runAggregatorSelfCritique\(/,
    "loop must reassign synthesis from self-critique result",
  );
});

test("MoaRunner.loop — uses thresholdForDeliverableShape for convergence (#5)", () => {
  // Structural: convergence threshold must derive from the rubric's
  // shape, not hard-coded to 0.7.
  assert.match(
    ALL_MOA_SRC,
    /thresholdForDeliverableShape\((?:this\.derivedRubric|host\.getDerivedRubric\(\))\?\.deliverableShape\)/,
    "convergence threshold must derive from rubric.deliverableShape",
  );
});

// 2026-05-02 (issue #2 fix): pickSelfCritiqueAgent picks a different
// agent than the winning aggregator. Imported from MoaRunner.ts; pure
// function so we can test directly.
test("pickSelfCritiqueAgent — prefers loser aggregator when K≥2 (#2)", () => {
  const winner = { id: "agg-2", index: 2, port: 0, sessionId: "s2" } as unknown as Parameters<
    typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent
  >[0]["winningAgg"];
  const aggregators = [
    { id: "agg-1", index: 1, port: 0, sessionId: "s1" },
    { id: "agg-2", index: 2, port: 0, sessionId: "s2" },
    { id: "agg-3", index: 3, port: 0, sessionId: "s3" },
  ] as unknown as Parameters<typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent>[0]["aggregators"];
  const proposers = [{ id: "p1", index: 0, port: 0, sessionId: "p1s" }] as unknown as Parameters<
    typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent
  >[0]["proposers"];
  const picked = pickSelfCritiqueAgent({ winningAgg: winner, aggregators, proposers, validSyntheses: [] });
  assert.notEqual(picked.id, "agg-2", "must NOT pick the winner");
  assert.ok(picked.id === "agg-1" || picked.id === "agg-3");
});

test("pickSelfCritiqueAgent — falls back to challenger proposer when K=1 (#2)", () => {
  const winner = { id: "agg-1", index: 1, port: 0, sessionId: "s1" } as unknown as Parameters<
    typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent
  >[0]["winningAgg"];
  const aggregators = [winner] as unknown as Parameters<
    typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent
  >[0]["aggregators"];
  const proposers = [
    { id: "p1", index: 1, port: 0, sessionId: "p1s" },
    { id: "p2-challenger", index: 2, port: 0, sessionId: "p2s" },
  ] as unknown as Parameters<typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent>[0]["proposers"];
  const picked = pickSelfCritiqueAgent({ winningAgg: winner, aggregators, proposers, validSyntheses: [] });
  assert.equal(picked.id, "p2-challenger", "must pick the LAST proposer (the challenger)");
});

test("pickSelfCritiqueAgent — falls back to winning aggregator when nothing else available", () => {
  const winner = { id: "agg-1", index: 1, port: 0, sessionId: "s1" } as unknown as Parameters<
    typeof import("./moaPromptHelpers.js").pickSelfCritiqueAgent
  >[0]["winningAgg"];
  const picked = pickSelfCritiqueAgent({
    winningAgg: winner,
    aggregators: [winner],
    proposers: [],
    validSyntheses: [],
  });
  assert.equal(picked.id, "agg-1");
});

test("MoaRunner.writeSummary — fires once + uses shared discussionWriteSummary helper (Phase C)", () => {
  assert.match(
    MOA_RUNNER_SRC,
    /protected async writeSummary\(cfg: RunConfig, crashMessage\?:/,
    "writeSummary signature must match the convention used by other runners",
  );
  assert.match(
    MOA_RUNNER_SRC,
    /if \(this\.summaryWritten\) return/,
    "writeSummary must early-exit on second call to be idempotent",
  );
  assert.match(
    MOA_RUNNER_SRC,
    /await discussionWriteSummary\(\{/,
    "writeSummary must call the shared discussionWriteSummary helper (Phase C)",
  );
  // MoA-specific: opts out of banner + files-in-log-line
  assert.match(MOA_RUNNER_SRC, /emitBanner: false/);
  assert.match(MOA_RUNNER_SRC, /includeFilesInLogLine: false/);
});
