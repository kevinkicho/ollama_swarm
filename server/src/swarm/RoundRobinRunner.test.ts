// 2026-05-02: tests for round-robin's structured-deliberation features
// (improvements #1, #2, #4). Pure-function tests; the runner-loop
// integration (#3 convergence stop, runStructuredSynthesisPass) is
// exercised in real round-robin sweeps.

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPOSITIONS,
  getDispositionForTurn,
  buildStructuredSynthesisPrompt,
  buildRoundRobinDeliverableSections,
} from "./roundRobinPromptHelpers.js";
import type { TranscriptEntry } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = readFileSync(join(__dirname, "RoundRobinRunner.ts"), "utf8");

/**
 * Robustly extract a preset object block from source by id.
 * Much more reliable than fixed-length [\s\S]{0,N} when comments or fields grow.
 */
function extractPresetBlock(source: string, id: string): string | null {
  const start = source.indexOf(`id: "${id}"`);
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  let inObject = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      inObject = true;
    } else if (ch === '}') {
      depth--;
      if (inObject && depth === 0) {
        // include the closing }
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}
const HELPERS_SRC = readFileSync(join(__dirname, "roundRobinPromptHelpers.ts"), "utf8");

describe("DISPOSITIONS — structured deliberation lenses", () => {
  it("ships exactly 4 dispositions: Critic / Synthesizer / Gap-finder / Builder", () => {
    assert.equal(DISPOSITIONS.length, 4);
    const names = DISPOSITIONS.map((d) => d.name);
    assert.ok(names.includes("Critic"));
    assert.ok(names.includes("Synthesizer"));
    assert.ok(names.includes("Gap-finder"));
    assert.ok(names.includes("Builder"));
  });

  it("each disposition has a non-empty framing", () => {
    for (const d of DISPOSITIONS) {
      assert.ok(d.framing.length > 30, `${d.name} framing too short`);
    }
  });
});

describe("dispositionFromPickerId / dispositionsAsRoleOptions (Q6)", () => {
  it("maps picker ids onto DISPOSITIONS", async () => {
    const {
      dispositionFromPickerId,
      dispositionsAsRoleOptions,
    } = await import("./roundRobinPromptHelpers.js");
    assert.equal(dispositionFromPickerId("critic")?.name, "Critic");
    assert.equal(dispositionFromPickerId("gap-finder")?.name, "Gap-finder");
    assert.equal(dispositionFromPickerId("gap_finder")?.name, "Gap-finder");
    assert.equal(dispositionFromPickerId("unknown"), null);
    const opts = dispositionsAsRoleOptions();
    assert.equal(opts.length, 4);
    assert.ok(opts.every((o) => o.id && o.label && o.description));
  });

  it("buildRoundRobinTurnPrompt honors dispositionOverride", async () => {
    const { buildRoundRobinTurnPrompt } = await import("./roundRobinPromptHelpers.js");
    const p = buildRoundRobinTurnPrompt({
      turnsTaken: 1,
      transcript: [],
      agentIndex: 1,
      totalRounds: 3,
      round: 1,
      dispositionOverride: {
        name: "Builder",
        framing: "Propose ONE concrete next action.",
      },
    });
    assert.match(p, /BUILDER disposition this turn/i);
    assert.match(p, /Propose ONE concrete next action/);
  });
});

describe("getDispositionForTurn", () => {
  it("turn 1 = Critic (first in cycle)", () => {
    assert.equal(getDispositionForTurn(1).name, "Critic");
  });

  it("cycles through 4 dispositions in order", () => {
    assert.equal(getDispositionForTurn(1).name, "Critic");
    assert.equal(getDispositionForTurn(2).name, "Synthesizer");
    assert.equal(getDispositionForTurn(3).name, "Gap-finder");
    assert.equal(getDispositionForTurn(4).name, "Builder");
  });

  it("turn 5 wraps back to Critic (modulo 4)", () => {
    assert.equal(getDispositionForTurn(5).name, "Critic");
    assert.equal(getDispositionForTurn(8).name, "Builder");
    assert.equal(getDispositionForTurn(9).name, "Critic");
  });

  it("handles turn 0 / negative defensively (clamps to valid index)", () => {
    // Edge case: if turnsTaken somehow underflows, must not crash
    const d = getDispositionForTurn(0);
    assert.ok(DISPOSITIONS.includes(d));
  });
});

describe("buildStructuredSynthesisPrompt", () => {
  const transcript = [
    { id: "1", role: "system" as const, text: "Run kicked off", ts: 1 },
    { id: "2", role: "agent" as const, agentIndex: 1, text: "I think the auth flow is fine.", ts: 2 },
    { id: "3", role: "agent" as const, agentIndex: 2, text: "I disagree — there's a race.", ts: 3 },
  ];

  it("includes the transcript with [Agent N] labels", () => {
    const p = buildStructuredSynthesisPrompt(2, transcript);
    assert.match(p, /\[Agent 1\] I think the auth flow is fine\./);
    assert.match(p, /\[Agent 2\] I disagree/);
    assert.match(p, /\[SYSTEM\] Run kicked off/);
  });

  it("frames the lead as the deliberation synthesis lead", () => {
    const p = buildStructuredSynthesisPrompt(3, []);
    assert.match(p, /You are Agent 1, the deliberation synthesis lead/);
    assert.match(p, /3 rounds of structured deliberation/);
  });

  it("requires Consensus / Disagreements / Recommended next step / Open questions (no directive)", () => {
    const p = buildStructuredSynthesisPrompt(2, []);
    assert.match(p, /\*\*Consensus\*\*/);
    assert.match(p, /\*\*Disagreements\*\*/);
    assert.match(p, /\*\*Recommended next step\*\*/);
    assert.match(p, /\*\*Open questions\*\*/);
    // No-directive path must NOT include the Answer-to-directive section
    assert.ok(!/\*\*Answer to directive\*\*/.test(p), "answer-to-directive should be absent without directive");
  });

  it("requires CONVERGENCE: high|medium|low on the final line", () => {
    const p = buildStructuredSynthesisPrompt(2, []);
    assert.match(p, /CONVERGENCE: high/);
    assert.match(p, /CONVERGENCE: medium/);
    assert.match(p, /CONVERGENCE: low/);
  });

  it("(#5) injects directive block + Answer-to-directive section when directive is set", () => {
    const p = buildStructuredSynthesisPrompt(
      2,
      [],
      "Refactor the auth module to use bcrypt instead of MD5.",
    );
    assert.match(p, /USER DIRECTIVE/);
    assert.match(p, /Refactor the auth module to use bcrypt instead of MD5\./);
    assert.match(p, /\*\*Answer to directive\*\*/);
    // Still keeps the other sections
    assert.match(p, /\*\*Consensus\*\*/);
    assert.match(p, /\*\*Disagreements\*\*/);
    assert.match(p, /\*\*Recommended next step\*\*/);
    assert.match(p, /\*\*Open questions\*\*/);
  });

  it("(#5) trims whitespace-only directive — treats as absent", () => {
    const p = buildStructuredSynthesisPrompt(2, [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(p), "whitespace-only directive must not inject directive block");
    assert.ok(!/\*\*Answer to directive\*\*/.test(p));
  });
});

// Structural tests for the runner — confirms the wiring is in place
// without needing to spin up a real agent manager.

test("RoundRobinRunner — turnsTaken increments per runTurn (#1)", () => {
  assert.match(
    RUNNER_SRC,
    /private turnsTaken = 0/,
    "turnsTaken field must exist for disposition rotation",
  );
  assert.match(
    RUNNER_SRC,
    /this\.turnsTaken \+= 1/,
    "runTurn must pre-increment turnsTaken",
  );
});

test("buildRoundRobinTurnPrompt — disposition + active-disagreement injected when no roles (#1+#2)", () => {
  assert.match(
    HELPERS_SRC,
    /disposition\.framing/,
    "disposition framing text must be injected",
  );
  assert.match(
    HELPERS_SRC,
    /ACTIVE-DISAGREEMENT RULE/,
    "active-disagreement rule must be present",
  );
});

test("(T185) NEXT-DISPOSITION VOTE prompt + parser + runner override are wired", () => {
  assert.match(
    HELPERS_SRC,
    /NEXT-DISPOSITION VOTE/,
    "prompt body must request the vote",
  );
  assert.match(
    HELPERS_SRC,
    /export function extractDispositionVote/,
    "parser must be exported",
  );
  assert.match(
    HELPERS_SRC,
    /export function pickNextDisposition/,
    "picker must be exported",
  );
  assert.match(
    HELPERS_SRC,
    /extractDispositionVote/,
    "parser must be exported",
  );
  assert.match(
    HELPERS_SRC,
    /pickNextDisposition/,
    "vote-based disposition picker must be exported",
  );
});

test("(T185) extractDispositionVote — returns the disposition name when present", async () => {
  const { extractDispositionVote } = await import("./roundRobinPromptHelpers.js");
  assert.equal(
    extractDispositionVote("...prose...\nNEXT-DISPOSITION VOTE: critic — claims accumulating"),
    "critic",
  );
  assert.equal(
    extractDispositionVote("...\nNext-Disposition Vote: GAP-FINDER — coverage missing"),
    "gap-finder",
  );
  assert.equal(
    extractDispositionVote("no vote here"),
    null,
  );
});

test("(T185) pickNextDisposition — picks majority vote from recent agent turns", async () => {
  const { pickNextDisposition } = await import("./roundRobinPromptHelpers.js");
  const transcript = [
    { id: "1", role: "agent" as const, agentIndex: 1, text: "p1\nNEXT-DISPOSITION VOTE: critic — x", ts: 1 },
    { id: "2", role: "agent" as const, agentIndex: 2, text: "p2\nNEXT-DISPOSITION VOTE: critic — y", ts: 2 },
    { id: "3", role: "agent" as const, agentIndex: 3, text: "p3\nNEXT-DISPOSITION VOTE: builder — z", ts: 3 },
  ];
  // 2 critic vs 1 builder → critic wins
  assert.equal(pickNextDisposition(transcript, 99).name, "Critic");
});

test("(T185) pickNextDisposition — tied votes fall back to mechanical rotation", async () => {
  const { pickNextDisposition, getDispositionForTurn } = await import("./roundRobinPromptHelpers.js");
  const transcript = [
    { id: "1", role: "agent" as const, agentIndex: 1, text: "p\nNEXT-DISPOSITION VOTE: critic — x", ts: 1 },
    { id: "2", role: "agent" as const, agentIndex: 2, text: "p\nNEXT-DISPOSITION VOTE: builder — y", ts: 2 },
  ];
  // 1-1 tie → fallback to mechanical
  assert.equal(
    pickNextDisposition(transcript, 5).name,
    getDispositionForTurn(5).name,
  );
});

test("(T185) pickNextDisposition — no votes in transcript → mechanical rotation", async () => {
  const { pickNextDisposition, getDispositionForTurn } = await import("./roundRobinPromptHelpers.js");
  const transcript = [
    { id: "1", role: "agent" as const, agentIndex: 1, text: "no vote here at all", ts: 1 },
  ];
  assert.equal(
    pickNextDisposition(transcript, 7).name,
    getDispositionForTurn(7).name,
  );
});

test("RoundRobinRunner — checkStructuredConvergence + runStructuredSynthesisPass exist (#3+#4)", () => {
  assert.match(
    RUNNER_SRC,
    /private async checkStructuredConvergence\(\): Promise<boolean>/,
    "checkStructuredConvergence must exist",
  );
  assert.match(
    RUNNER_SRC,
    /private async runStructuredSynthesisPass\(/,
    "runStructuredSynthesisPass must exist",
  );
});

test("RoundRobinRunner.loop — convergence check fires for no-roles round 2+ (#3)", () => {
  assert.match(
    RUNNER_SRC,
    /!this\.roles\s*&&\s*!this\.stopping\s*&&\s*r >= 2[\s\S]{0,200}checkStructuredConvergence/,
    "convergence check must gate on no-roles + r >= 2",
  );
});

test("RoundRobinRunner.loop — final synthesis fires for no-roles when not early-stopped (#4)", () => {
  assert.match(
    RUNNER_SRC,
    /!this\.roles\s*&&\s*!this\.stopping\s*&&\s*cfg\.rounds > 0[\s\S]{0,200}runStructuredSynthesisPass/,
    "final synthesis must gate on no-roles AND no early-stop",
  );
});

// 2026-05-02 (improvement #5): user-directive plumbing — round-robin
// is no longer "ignored — analysis-only preset". Verifies the wiring
// across seed → buildPrompt → synthesis.

test("(#5 + Phase A) seed uses readDirective + buildDirectiveBlock helpers", () => {
  assert.match(
    RUNNER_SRC,
    /buildRoundRobinSeedMessage/,
    "seed must call buildRoundRobinSeedMessage",
  );
  const seedSrc = readFileSync(join(__dirname, "roundRobinSeed.ts"), "utf8");
  assert.match(
    seedSrc,
    /readDirective\(cfg\)/,
    "seed module must call readDirective(cfg) via shared helper",
  );
  assert.match(
    seedSrc,
    /buildDirectiveBlock\(/,
    "seed module must call buildDirectiveBlock via shared helper",
  );
});

test("(#5 + Phase A) buildPrompt reads this.active?.userDirective via readDirective + buildDirectiveBlock", () => {
  assert.match(
    HELPERS_SRC,
    /readDirective\(\{\s*userDirective\s*\}/,
    "buildRoundRobinTurnPrompt must use readDirective with userDirective",
  );
  assert.match(
    HELPERS_SRC,
    /labelSuffix:\s*"\(the question this deliberation must resolve\)"/,
    "buildRoundRobinTurnPrompt directive block must use the deliberation label suffix",
  );
  assert.match(
    HELPERS_SRC,
    /\.\.\.directiveBlock,/,
    "directiveBlock must be spread into the prompt body",
  );
});

test("(#5) buildPrompt swaps generic goals for directive-driven goals when directive set", () => {
  assert.match(
    HELPERS_SRC,
    /Goals of this deliberation:/,
    "directive-set path must use 'Goals of this deliberation' framing",
  );
  assert.match(
    HELPERS_SRC,
    /advance the team's answer to the directive/,
    "directive goal #2 must reference the directive directly",
  );
});

test("(#5) runStructuredSynthesisPass passes cfg.userDirective into prompt builder", () => {
  const synthSrc = readFileSync(join(__dirname, "roundRobinSynthesis.ts"), "utf8");
  assert.match(
    synthSrc,
    /buildStructuredSynthesisPrompt\(cfg\.rounds, (?:this|host)\.transcript, cfg\.userDirective\)/,
    "synthesis must thread the directive into the builder",
  );
});

import { readFileSync as _read } from "node:fs";
import { join as _join } from "node:path";

test("(#5) web preset spec marks round-robin as directive: 'honored'", () => {
  const presetsSrc = _read(
    _join(__dirname, "../../../web/src/components/setup/presets.ts"),
    "utf8",
  );
  const roundRobinBlock = extractPresetBlock(presetsSrc, "round-robin");
  assert.ok(roundRobinBlock, "round-robin preset block must exist");
  assert.match(
    roundRobinBlock,
    /directive:\s*"honored"/,
    "round-robin must be 'honored' (improvement #5)",
  );
});

// 2026-05-02 (role-diff #1+#2+#3+#4): structural tests for the four
// role-diff levers shipped on top of the round-robin runner.

test("(role-diff #3) buildRoundRobinTurnPrompt injects deliverableBlock when role is configured", () => {
  assert.match(
    HELPERS_SRC,
    /const deliverableBlock = role/,
    "deliverableBlock must be conditional on role being set",
  );
  assert.match(
    HELPERS_SRC,
    /MY DELIVERABLE CONTRACT/,
    "deliverable contract framing must be in the prompt",
  );
  assert.match(
    HELPERS_SRC,
    /\.\.\.deliverableBlock,/,
    "deliverableBlock must be spread into the prompt body",
  );
});

test("(role-diff #3) buildRoundRobinTurnPrompt's role+directive goals path replaces dispositional copy with role-specialist copy", () => {
  // When BOTH role + directive are set, the goals block must talk
  // about "your specialist piece", not "your assigned disposition".
  assert.match(
    HELPERS_SRC,
    /produce YOUR specialist piece of the directive's answer/,
    "role+directive goals must frame agent as specialist contributor",
  );
});

test("(role-diff #4) loop fires writeDeliverableAndEmit for role-diff runs", () => {
  assert.match(
    RUNNER_SRC,
    /this\.roles\s*&&\s*!this\.stopping\s*&&\s*cfg\.runId[\s\S]{0,400}buildRoleDiffDeliverableSections/,
    "deliverable composition must gate on roles + not-stopping + runId",
  );
  assert.match(
    RUNNER_SRC,
    /writeDeliverableAndEmit\(\s*\{\s*preset:\s*"role-diff"/,
    "deliverable write must use preset: 'role-diff'",
  );
});

test("(T1.1) loop fires writeDeliverableAndEmit for plain round-robin runs (no roles)", () => {
  // Mirror of the role-diff #4 check: the no-roles structured-
  // deliberation path must also write a deliverable so EVERY round-
  // robin run produces a portable artifact, not just role-diff.
  assert.match(
    RUNNER_SRC,
    /!this\.roles\s*&&\s*!this\.stopping\s*&&\s*cfg\.runId[\s\S]{0,400}buildRoundRobinDeliverableSections/,
    "plain round-robin deliverable composition must gate on !roles + not-stopping + runId",
  );
  assert.match(
    RUNNER_SRC,
    /writeDeliverableAndEmit\(\s*\{\s*preset:\s*"round-robin"/,
    "plain round-robin deliverable write must use preset: 'round-robin'",
  );
});

test("(T1.1) buildRoundRobinDeliverableSections — directive section first, synthesis second, next-actions last", () => {
  const transcript: TranscriptEntry[] = [
    {
      id: "1",
      role: "agent",
      agentIndex: 1,
      text: "Critic: the README claims X but tests don't cover it.",
      ts: 1,
      summary: { kind: "agent_turn", round: 1, agentIndex: 1 } as never,
    },
    {
      id: "2",
      role: "agent",
      agentIndex: 2,
      text: "Synthesizer: agreed; gap is in src/api/.",
      ts: 2,
      summary: { kind: "agent_turn", round: 1, agentIndex: 2 } as never,
    },
    {
      id: "3",
      role: "agent",
      agentIndex: 1,
      text: "FINAL SYNTHESIS:\nThe team converged on the README/test gap in src/api/. Recommended next step: add coverage for X.",
      ts: 3,
      summary: { kind: "role_diff_synthesis", rounds: 2, roles: 0 },
    },
  ];
  const sections = buildRoundRobinDeliverableSections({
    cfg: { userDirective: "Audit README claims", agentCount: 2, rounds: 2 },
    transcript,
    actualRounds: 2,
  });
  // Directive first
  assert.equal(sections[0]!.title, "Directive");
  // Answer/synthesis second when directive set
  assert.match(sections[1]!.title, /directive|synthesis/i);
  assert.match(sections[1]!.body, /converged on the README\/test gap/);
  // Next actions always last (pure parser, free)
  assert.equal(sections[sections.length - 1]!.title, "Next actions");
});

test("(T1.1) buildRoundRobinDeliverableSections — no directive: skips directive section, uses 'Final synthesis' title", () => {
  const transcript: TranscriptEntry[] = [
    {
      id: "1",
      role: "agent",
      agentIndex: 1,
      text: "Open synthesis text",
      ts: 1,
      summary: { kind: "role_diff_synthesis", rounds: 1, roles: 0 },
    },
  ];
  const sections = buildRoundRobinDeliverableSections({
    cfg: { agentCount: 1, rounds: 1 },
    transcript,
    actualRounds: 1,
  });
  // No directive → no Directive section
  assert.notEqual(sections[0]!.title, "Directive");
  // Title falls back to "Final synthesis"
  assert.ok(sections.some((s) => s.title === "Final synthesis"));
});

test("(role-diff #2) Orchestrator uses selectRoleCatalog for both runner instantiation and run-started event", () => {
  const orch = _read(
    _join(__dirname, "../services/Orchestrator.ts"),
    "utf8",
  );
  // Both the role-name resolution for run_started AND the runner
  // factory must go through selectRoleCatalog so the catalog is
  // chosen consistently (and BUILD_ROLES kicks in when directive set).
  const matches = orch.match(/selectRoleCatalog\(/g);
  assert.ok(
    matches && matches.length >= 2,
    `expected >= 2 selectRoleCatalog call sites in Orchestrator, got ${matches?.length ?? 0}`,
  );
});

test("(role-diff #2+#4) web preset spec marks role-diff as directive: 'honored'", () => {
  const presets = _read(
    _join(__dirname, "../../../web/src/components/setup/presets.ts"),
    "utf8",
  );
  const roleDiffBlock = extractPresetBlock(presets, "role-diff");
  assert.ok(roleDiffBlock, "role-diff preset block must exist");
  assert.match(
    roleDiffBlock,
    /directive:\s*"honored"/,
    "role-diff must be 'honored' after improvement #2",
  );
});
