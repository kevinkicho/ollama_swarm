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

// The value of Council over round-robin is that within a round, no agent can
// see another agent's output. buildCouncilPrompt is the choke-point that
// enforces this — if a future refactor breaks it, these tests break.

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
    // "Agent 2" / "Agent 3" in the transcript BODY would mean a peer entry
    // leaked in. The prompt HEADER legitimately names the requesting agent
    // ("You are Agent 4"), so we check for the transcript-body format instead.
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

  it("announces the round is a draft round in round 1", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, [system("seed")]);
    assert.match(prompt, /ROUND 1.*independent first draft/i);
    assert.match(prompt, /peer drafts hidden/i);
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

  it("announces the round is a revision round in round 2+", () => {
    const prompt = buildCouncilPrompt(1, 2, 3, [system("seed")]);
    assert.match(prompt, /ROUND 2.*revision/i);
    assert.match(prompt, /other agents' prior drafts/i);
  });

  it("still includes peers in round 3", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed"),
      agent(2, "something important"),
    ];
    const prompt = buildCouncilPrompt(1, 3, 3, snapshot);
    assert.ok(prompt.includes("something important"));
    assert.match(prompt, /ROUND 3.*revision/i);
  });
});

describe("buildCouncilPrompt — general shape", () => {
  it("identifies the requesting agent in both the header and the closing line", () => {
    const prompt = buildCouncilPrompt(4, 1, 3, []);
    assert.ok(prompt.includes("You are Agent 4"));
    assert.ok(prompt.includes("Now respond as Agent 4."));
  });

  it("states the overall discussion goals (no directive)", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, []);
    assert.match(prompt, /1\. Figure out what this project is/);
    assert.match(prompt, /2\. Identify what is working/);
    assert.match(prompt, /3\. Propose one concrete next action/);
  });
});

// 2026-05-02 (council improvement #1+#2): directive-aware prompts +
// position pre-registration contract.

describe("buildCouncilPrompt — directive injection (improvement #1)", () => {
  it("injects USER DIRECTIVE block when a directive is set", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "Refactor auth to use bcrypt.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth to use bcrypt\./);
  });

  it("swaps the generic 3-goal block for directive-driven goals when set", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "Refactor auth.");
    assert.match(prompt, /Goals of this council:/);
    assert.match(prompt, /produce YOUR independent answer to the directive/);
    // Generic copy must NOT leak into the directive path
    assert.ok(!/Figure out what this project is/.test(prompt));
  });

  it("treats whitespace-only directive as absent", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.match(prompt, /Figure out what this project is/);
  });
});

describe("buildCouncilPrompt — position contract (improvement #2)", () => {
  it("Round 1 requires a one-line `### MY POSITION` block", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "x");
    assert.match(prompt, /POSITION CONTRACT/);
    assert.match(prompt, /### MY POSITION/);
    assert.match(prompt, /one short sentence/);
  });

  it("Round 2+ requires explicit KEEP / CHANGE ownership against prior position", () => {
    const prompt = buildCouncilPrompt(2, 2, 3, [], "x");
    assert.match(prompt, /POSITION CONTRACT/);
    assert.match(prompt, /KEEP:.*CHANGE:/);
    assert.match(prompt, /WHY:/);
    assert.match(prompt, /Drift without an explicit CHANGE is the failure mode/);
  });

  it("Round 2+ surfaces the agent's OWN prior position from the snapshot", () => {
    const snapshot: TranscriptEntry[] = [
      {
        id: "a1-r1",
        role: "agent",
        agentIndex: 2,
        text: "draft prose\n### MY POSITION\nUNIQUE_PRIOR_POS_X",
        ts: 1,
      },
    ];
    const prompt = buildCouncilPrompt(2, 2, 3, snapshot);
    assert.match(prompt, /YOUR PRIOR POSITION \(from last round\)/);
    assert.match(prompt, /UNIQUE_PRIOR_POS_X/);
  });

  it("Round 2+ falls back to a 'start fresh' placeholder when no prior position exists", () => {
    const snapshot: TranscriptEntry[] = [
      // agent 2 produced a draft but didn't comply with the contract
      {
        id: "a2-r1",
        role: "agent",
        agentIndex: 2,
        text: "noncompliant draft, no MY POSITION block",
        ts: 1,
      },
    ];
    const prompt = buildCouncilPrompt(2, 2, 3, snapshot);
    assert.match(prompt, /YOUR PRIOR POSITION/);
    assert.match(prompt, /you did not produce a `### MY POSITION` block last round/);
  });

  it("Round 1 does NOT include the prior-position block (no prior round exists)", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "x");
    assert.ok(!/YOUR PRIOR POSITION/.test(prompt));
  });

  it("closing instruction reminds the agent to end with the position block", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "x");
    assert.match(prompt, /End with your `### MY POSITION` block/);
  });
});

describe("buildCouncilSynthesisPrompt — directive + minority report (improvement #1+#3)", () => {
  it("when no directive, uses the original Consensus / Disagreements / Next-action structure", () => {
    const prompt = buildCouncilSynthesisPrompt(2, []);
    assert.match(prompt, /\*\*Consensus\*\*/);
    assert.match(prompt, /\*\*Disagreements\*\*/);
    assert.match(prompt, /\*\*Next action\*\*/);
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.ok(!/Answer to directive/.test(prompt));
  });

  it("when directive set, leads with USER DIRECTIVE block + Answer-to-directive section", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], "Refactor auth.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth\./);
    assert.match(prompt, /\*\*Answer to directive\*\*/);
  });

  it("(#3) requires a Minority report section in BOTH directive and no-directive paths", () => {
    const noDirective = buildCouncilSynthesisPrompt(2, []);
    const withDirective = buildCouncilSynthesisPrompt(2, [], "x");
    for (const p of [noDirective, withDirective]) {
      assert.match(p, /\*\*Minority report\*\*/);
      // "verbatim" is bolded with `**` so use two anchored substrings
      // around it instead of a single regex spanning the bolding.
      assert.match(p, /strongest argument/);
      assert.match(p, /from their last position/);
      assert.match(p, /_consensus reached.*no minority position_/);
      assert.match(p, /Do NOT invent dissent for show/);
    }
  });

  it("preserves CONVERGENCE: high|medium|low signal in both paths", () => {
    for (const p of [
      buildCouncilSynthesisPrompt(2, []),
      buildCouncilSynthesisPrompt(2, [], "x"),
    ]) {
      assert.match(p, /CONVERGENCE: high/);
      assert.match(p, /CONVERGENCE: medium/);
      assert.match(p, /CONVERGENCE: low/);
    }
  });
});

// Structural tests for the runner — confirms wiring is in place
// without spinning up real agents.

test("(#1) CouncilRunner.seed uses readDirective + buildDirectiveBlock helpers (Phase A)", () => {
  // Post-Phase-A: directive plumbing is via shared helpers, not inline.
  assert.match(
    COUNCIL_SRC,
    /readDirective\(cfg\)/,
    "seed must call readDirective(cfg) via shared helper",
  );
  assert.match(
    COUNCIL_SRC,
    /buildDirectiveBlock\(/,
    "seed must call buildDirectiveBlock via shared helper",
  );
});

test("(#1) CouncilRunner.runTurn forwards cfg.userDirective into buildCouncilPrompt", () => {
  assert.match(
    COUNCIL_SRC,
    /this\.runTurn\(agent, r, cfg\.rounds, snapshot, cfg\.userDirective\)/,
    "loop must thread cfg.userDirective into runTurn",
  );
  assert.match(
    COUNCIL_SRC,
    /buildCouncilPrompt\(agent\.index, round, totalRounds, visible, userDirective\)/,
    "runTurn must thread userDirective into buildCouncilPrompt",
  );
});

test("(#1) CouncilRunner.runSynthesisPass forwards cfg.userDirective into buildCouncilSynthesisPrompt", () => {
  assert.match(
    COUNCIL_SRC,
    /buildCouncilSynthesisPrompt\(cfg\.rounds, this\.transcript, cfg\.userDirective\)/,
    "synthesis pass must thread userDirective into the prompt builder",
  );
});

test("(#4 + Phase A) writeCouncilDeliverable composes Directive + Per-agent positions sections via shared helpers", () => {
  assert.match(
    COUNCIL_SRC,
    /buildCouncilPositionsSection\(\s*this\.transcript,\s*cfg\.agentCount,?\s*\)/,
    "deliverable must include the per-agent positions section",
  );
  // Title + Directive section both via shared helpers (post Phase A).
  assert.match(
    COUNCIL_SRC,
    /pickDeliverableTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Council: directive answer"/,
    "deliverable title must use pickDeliverableTitle helper",
  );
  assert.match(
    COUNCIL_SRC,
    /maybeDirectiveSection\(dirCtx\)/,
    "deliverable must use maybeDirectiveSection helper",
  );
  assert.match(
    COUNCIL_SRC,
    /pickDeliverableSubtitle\(dirCtx,/,
    "deliverable subtitle must use pickDeliverableSubtitle helper",
  );
  assert.match(
    COUNCIL_SRC,
    /pickAnswerSectionTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Answer to directive"/,
    "synthesis section title must use pickAnswerSectionTitle helper",
  );
});

test("(form) council preset is now directive: 'honored'", () => {
  const setup = readFileSync(
    join(__dirname, "../../../web/src/components/SetupForm.tsx"),
    "utf8",
  );
  const block = setup.match(/id:\s*"council"[\s\S]{0,1500}?\},/);
  assert.ok(block, "council preset block must exist");
  assert.match(
    block![0],
    /directive:\s*"honored"/,
    "council must be 'honored' after improvement #1",
  );
});
