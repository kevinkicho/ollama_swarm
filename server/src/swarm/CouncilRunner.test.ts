import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCouncilPrompt,
  buildCouncilSynthesisPrompt,
} from "./CouncilRunner.js";
import type { TranscriptEntry } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNCIL_SRC = readFileSync(join(__dirname, "CouncilRunner.ts"), "utf8");
const DELIVERABLE_SRC = readFileSync(join(__dirname, "councilDeliverable.ts"), "utf8");
const SYNTHESIS_SRC = readFileSync(join(__dirname, "councilSynthesis.ts"), "utf8");
const AUDIT_CYCLE_SRC = readFileSync(join(__dirname, "councilAuditCycle.ts"), "utf8");
const SEED_SRC = readFileSync(join(__dirname, "councilSeed.ts"), "utf8");
const STANDUP_SRC = readFileSync(join(__dirname, "councilStandup.ts"), "utf8");
const PROMPT_HELPERS_SRC = readFileSync(join(__dirname, "councilPromptHelpers.ts"), "utf8");
const STOP_SRC = readFileSync(join(__dirname, "councilStop.ts"), "utf8");
const CYCLE_SRC = readFileSync(join(__dirname, "councilRunCycle.ts"), "utf8");
const ALL_COUNCIL_SRC = [
  COUNCIL_SRC,
  DELIVERABLE_SRC,
  SYNTHESIS_SRC,
  AUDIT_CYCLE_SRC,
  SEED_SRC,
  STANDUP_SRC,
  PROMPT_HELPERS_SRC,
  STOP_SRC,
  CYCLE_SRC,
].join("\n");

const system = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
  text,
  ts: 0,
});

const user = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "user",
  text,
  ts: 0,
});

const agent = (index: number, text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "agent",
  agentIndex: index,
  agentId: `agent-${index}`,
  text,
  ts: 0,
});

describe("buildCouncilPrompt — round 1 independence", () => {
  it("omits peer-agent entries from the transcript body in round 1", () => {
    const snapshot: TranscriptEntry[] = [
      system("Cloned repo-x to /tmp/clone"),
      agent(2, "FORBIDDEN_CONTENT_ALPHA xyz123"),
      agent(3, "FORBIDDEN_CONTENT_BETA qwe456"),
    ];
    const prompt = buildCouncilPrompt(1, 1, 3, snapshot);
    assert.ok(
      !prompt.includes("FORBIDDEN_CONTENT_ALPHA"),
      "round 1 prompt must not include peer agent 2's draft body",
    );
    assert.ok(
      !prompt.includes("FORBIDDEN_CONTENT_BETA"),
      "round 1 prompt must not include peer agent 3's draft body",
    );
    assert.ok(!prompt.includes("[Agent 2]"), "round 1 must not show a [Agent 2] transcript line");
    assert.ok(!prompt.includes("[Agent 3]"), "round 1 must not show a [Agent 3] transcript line");
    assert.ok(prompt.includes("Cloned repo-x to /tmp/clone"), "round 1 must still include system seed");
  });

  it("keeps system and user entries visible in round 1", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed message"),
      user("human question"),
      agent(5, "FORBIDDEN_PEER_CONTENT"),
    ];
    const prompt = buildCouncilPrompt(1, 1, 3, snapshot);
    assert.ok(prompt.includes("[SYSTEM] seed message"));
    assert.ok(prompt.includes("[HUMAN] human question"));
    assert.ok(!prompt.includes("FORBIDDEN_PEER_CONTENT"));
  });

  it("announces the round is a code audit in round 1", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, [system("seed")]);
    assert.match(prompt, /auditing the codebase/i);
    assert.match(prompt, /PROJECT CONTEXT/i);
  });

  it("handles an empty transcript gracefully in round 1", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, []);
    assert.ok(prompt.includes("(empty — you are writing the first entry)"));
  });
});

describe("buildCouncilPrompt — round 2+ reveal", () => {
  it("includes peer-agent entries in the transcript body in round 2", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed"),
      agent(1, "round-1 draft by agent 1"),
      agent(2, "round-1 draft by agent 2"),
      agent(3, "round-1 draft by agent 3"),
    ];
    const prompt = buildCouncilPrompt(1, 2, 3, snapshot);
    assert.ok(prompt.includes("round-1 draft by agent 1"));
    assert.ok(prompt.includes("round-1 draft by agent 2"));
    assert.ok(prompt.includes("round-1 draft by agent 3"));
  });

  it("announces the round is a follow-up audit in round 2+", () => {
    const prompt = buildCouncilPrompt(1, 2, 3, [system("seed")]);
    assert.match(prompt, /round 2 of 3/i);
    assert.match(prompt, /other agents' findings/i);
  });

  it("still includes peers in round 3", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed"),
      agent(2, "something important"),
    ];
    const prompt = buildCouncilPrompt(1, 3, 3, snapshot);
    assert.ok(prompt.includes("something important"));
    assert.match(prompt, /round 3 of 3/i);
  });
});

describe("buildCouncilPrompt — general shape", () => {
  it("identifies the requesting agent in both the header and the closing line", () => {
    const prompt = buildCouncilPrompt(4, 1, 3, []);
    assert.ok(prompt.includes("You are Agent 4"));
    assert.ok(prompt.includes("Now respond as Agent 4."));
  });

  it("states the audit goals (no directive)", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, []);
    assert.match(prompt, /auditing the codebase/i);
    assert.match(prompt, /READ the actual code/i);
    assert.match(prompt, /identify what's broken/i);
  });
});

describe("buildCouncilPrompt — directive injection", () => {
  it("injects USER DIRECTIVE block when a directive is set", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "Refactor auth to use bcrypt.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth to use bcrypt\./);
  });

  it("includes directive-driven instructions when set", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "Refactor auth.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth/);
    assert.ok(!/Figure out what this project is/.test(prompt));
  });

  it("treats whitespace-only directive as absent", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.match(prompt, /auditing the codebase/i);
  });
});

describe("buildCouncilSynthesisPrompt", () => {
  it("produces an action plan structure", () => {
    const prompt = buildCouncilSynthesisPrompt(2, []);
    assert.match(prompt, /merged action plan/i);
    assert.match(prompt, /AGENT FINDINGS/i);
  });

  it("when directive set, includes USER DIRECTIVE block", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], "Refactor auth.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth\./);
  });

  it("includes committed files block when provided", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], undefined, ["src/foo.ts", "src/bar.ts"]);
    assert.match(prompt, /ALREADY COMMITTED/);
    assert.match(prompt, /src\/foo\.ts/);
    assert.match(prompt, /src\/bar\.ts/);
  });

  it("includes ambition tier guidance when tier > 1", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], undefined, undefined, 3);
    assert.match(prompt, /ambition tier 3/);
    assert.match(prompt, /MATERIALLY MORE AMBITIOUS/);
  });
});

test("CouncilRunner.seed uses readDirective + buildDirectiveBlock helpers", () => {
  assert.match(
    ALL_COUNCIL_SRC,
    /readDirective\(cfg\)/,
    "seed must call readDirective(cfg) via shared helper",
  );
  assert.match(
    ALL_COUNCIL_SRC,
    /buildDirectiveBlock\(/,
    "seed must call buildDirectiveBlock via shared helper",
  );
});

test("CouncilRunner.runTurn forwards cfg.userDirective into buildCouncilPrompt", () => {
  assert.match(
    ALL_COUNCIL_SRC,
    /(?:this|host)\.runTurn\(agent, r, (3|effectiveRounds|cfg\.rounds), snapshot, cfg\.userDirective\)/,
    "loop must thread cfg.userDirective into runTurn",
  );
  assert.match(
    ALL_COUNCIL_SRC,
    /buildCouncilPrompt\(/,
    "runTurn must thread userDirective into buildCouncilPrompt",
  );
  assert.match(
    ALL_COUNCIL_SRC,
    /buildStandupPrompt\(/,
    "standup prompt builder must exist",
  );
});

test("CouncilRunner.runSynthesisPass forwards cfg.userDirective into buildCouncilSynthesisPrompt", () => {
  assert.match(
    ALL_COUNCIL_SRC,
    /buildCouncilSynthesisPrompt\(/,
    "synthesis pass must thread userDirective into the prompt builder",
  );
});

test("CouncilRunner.stop — hard stop enters stopping, writes summary, kills agents", () => {
  assert.match(
    COUNCIL_SRC,
    /async stop\(\): Promise<void>/,
    "CouncilRunner must implement stop()",
  );
  assert.match(
    ALL_COUNCIL_SRC,
    /enterImmediateShutdown/,
    "hard stop must freeze transcript and suppress streaming before close-out waits",
  );
  assert.match(
    STOP_SRC,
    /beginRunShutdown/,
    "hard stop must abort in-flight provider work immediately",
  );
  assert.match(
    STOP_SRC,
    /setPhase\("stopping"\)/,
    "hard stop must enter stopping phase immediately (not draining)",
  );
  assert.match(
    STOP_SRC,
    /writeSummary/,
    "hard stop must write run summary before tearing down agents",
  );
  assert.match(
    STOP_SRC,
    /formatPortReleaseLine/,
    "hard stop must emit kill result transcript line",
  );
  // Facade stop() only delegates — drain phase is exclusive to councilDrain.
  assert.match(COUNCIL_SRC, /councilStopExtracted/);
  assert.doesNotMatch(
    STOP_SRC.match(/export async function councilStop[\s\S]*?^export async function councilDrain/m)?.[0] ?? "",
    /setPhase\("draining"\)/,
    "hard stop must not use draining phase (soft drain is drain())",
  );
});

test("CouncilRunner — enqueues synthesis todos after cycle 1 synthesis", () => {
  assert.match(
    CYCLE_SRC,
    /extractActionableTodos\(/,
    "cycle 1 must extract actionable todos from synthesis",
  );
  assert.match(
    CYCLE_SRC,
    /createdBy: "council-synthesis"/,
    "synthesis todos must be posted to the queue",
  );
});

test("CouncilRunner — reconciles worker skips before audit", () => {
  assert.match(
    ALL_COUNCIL_SRC,
    /reconcileCriteriaFromSkips/,
    "must promote criteria when workers skip with already-done reasons",
  );
  assert.match(
    ALL_COUNCIL_SRC,
    /skipEvidence/,
    "must pass skip evidence into council audit",
  );
});

test("CouncilRunner.drain — soft stop is separate from hard stop", () => {
  assert.match(
    COUNCIL_SRC,
    /async drain\(\): Promise<void>/,
    "CouncilRunner must expose drain() for soft stop",
  );
  assert.match(
    STOP_SRC,
    /setPhase\("draining"\)/,
    "soft drain must enter draining phase",
  );
});

test("CouncilRunner — summary is written after loop settles on drain/stop", () => {
  assert.match(ALL_COUNCIL_SRC, /closingRequested/, "must gate audit on drain/stop");
  assert.match(ALL_COUNCIL_SRC, /awaitLoopThenCloseOut/, "must await loop before close-out summary");
  assert.match(ALL_COUNCIL_SRC, /workerDrainPromise/, "stop must wait for execution workers");
  assert.match(
    ALL_COUNCIL_SRC,
    /HARD_STOP_WORKER_WAIT_MS|forcing abort before killAll/,
    "hard stop must force abort when worker wait times out",
  );
  // Audit cycle host uses closingRequested() after extract from the facade.
  assert.match(
    AUDIT_CYCLE_SRC,
    /if \(host\.closingRequested\(\)\) return "stop"/,
    "must skip audit when draining",
  );
});

test("CouncilRunner.stop — hard stop must not set drainRequested (soft drain only)", () => {
  const stopBody = COUNCIL_SRC.match(/async stop\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.doesNotMatch(stopBody, /drainRequested\s*=\s*true/);
});

test("CouncilRunner — audit stuck sets earlyStopDetail and terminal message before summary", () => {
  // Stuck detector lives in councilAuditCycle (extracted from CouncilRunner facade).
  assert.match(AUDIT_CYCLE_SRC, /setEarlyStopDetail\(`audit-stuck:/, "stuck stop must set earlyStopDetail");
  assert.match(ALL_COUNCIL_SRC, /appendCouncilTerminalMessage/, "terminal line must precede summary write");
  assert.match(ALL_COUNCIL_SRC, /reconcileCriteriaFromLedger/, "must reconcile criteria from ledger commits");
  assert.match(ALL_COUNCIL_SRC, /buildUnmetFailSignature/, "stuck detector must use ledger fail signature");
  assert.doesNotMatch(ALL_COUNCIL_SRC, /tryBrainFallback/i, "council run recovery must not use in-run brain");
});

test("CouncilRunner — ambition tier-up returns retry so multi-cycle / autonomous runs continue", () => {
  // Regression: run 0f28f5e8 ended after "Tier 2 installed — continuing…" because
  // promotion returned "done" and the outer loop breaks on "done" when rounds>0.
  const promoteBlock = AUDIT_CYCLE_SRC.match(
    /if \(promoted\) \{[\s\S]*?return "(?:retry|done|stop)";/,
  )?.[0] ?? "";
  assert.match(
    promoteBlock,
    /return "retry"/,
    "successful tier promotion must return retry (not done) so the next cycle runs",
  );
  assert.doesNotMatch(
    promoteBlock,
    /return "done"/,
    "tier promotion must not return done (that ends finite-round council runs)",
  );
  assert.match(
    promoteBlock,
    /ambition-tier-up-ok/,
    "promote success path must log ambition-tier-up-ok",
  );
  assert.match(
    COUNCIL_SRC,
    /const isAutonomous = cfg\.rounds === 0 \|\| cfg\.rounds >= 1_000_000/,
    "autonomous mode must treat rounds=0 and continuous (1e6) as open-ended",
  );
  assert.match(
    COUNCIL_SRC,
    /decideCouncilLoopAfterCycle/,
    "outer loop must use settlement policy (soft done is real; no clear-and-spin)",
  );
  assert.doesNotMatch(
    COUNCIL_SRC,
    /earlyStopDetail\s*=\s*undefined/,
    "must not clear earlyStopDetail on soft-done (erases real stop reasons)",
  );
  assert.match(
    COUNCIL_SRC,
    /resolveCouncilMaxTiers/,
    "must resolve ambition max tiers from run config",
  );
});

test("resolveCouncilMaxTiers — rounds=0 unbounded; ambitionTiers=0 disables", async () => {
  const { resolveCouncilMaxTiers } = await import("./CouncilRunner.js");
  assert.equal(resolveCouncilMaxTiers({ rounds: 0 }), Infinity);
  assert.equal(resolveCouncilMaxTiers({ rounds: 1_000_000 }), Infinity);
  assert.equal(resolveCouncilMaxTiers({ rounds: 5, ambitionTiers: 0 }), 1);
  assert.equal(resolveCouncilMaxTiers({ rounds: 5, ambitionTiers: 3 }), 3);
  assert.equal(resolveCouncilMaxTiers({ rounds: 5 }), Infinity);
});
