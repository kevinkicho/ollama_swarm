import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDebaterPrompt,
  buildJudgePrompt,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildSignoffPrompt,
  DEFAULT_PROPOSITION,
  scanImplementerForNoOp,
} from "./debatePromptHelpers.js";
import type { TranscriptEntry } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJ_SRC = readFileSync(join(__dirname, "DebateJudgeRunner.ts"), "utf8");
const DJ_DELIVERABLE_SRC = readFileSync(join(__dirname, "debateDeliverableWriter.ts"), "utf8");
const DJ_PROMPT_SRC = readFileSync(join(__dirname, "debatePromptHelpers.ts"), "utf8");
const DJ_ALL = [DJ_SRC, DJ_DELIVERABLE_SRC, DJ_PROMPT_SRC].join("\n\n");

const STUB_VERDICT = {
  winner: "pro" as const,
  confidence: "high" as const,
  proStrongest: "x",
  conStrongest: "y",
  proWeakest: "p",
  conWeakest: "q",
  decisive: "PRO had stronger evidence.",
  nextAction: "Land the bcrypt migration in a single PR.",
};

const system = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
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

describe("DEFAULT_PROPOSITION", () => {
  it("has a non-empty default so runs don't crash when user doesn't set one", () => {
    assert.ok(DEFAULT_PROPOSITION.length > 0);
  });
});

describe("buildDebaterPrompt — side-specific framing", () => {
  it("PRO prompt identifies agent 1 and commits to arguing FOR", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 1,
      totalRounds: 3,
      proposition: "Cats are better than dogs",
      isFinalRound: false,
      transcript: [],
    });
    assert.ok(prompt.includes("Agent 1"));
    assert.match(prompt, /PRO \(arguing FOR\)/);
    assert.match(prompt, /argue FOR the proposition/);
  });

  it("CON prompt identifies agent 2 and commits to arguing AGAINST", () => {
    const prompt = buildDebaterPrompt({
      side: "con",
      round: 1,
      totalRounds: 3,
      proposition: "Cats are better than dogs",
      isFinalRound: false,
      transcript: [],
    });
    assert.ok(prompt.includes("Agent 2"));
    assert.match(prompt, /CON \(arguing AGAINST\)/);
    assert.match(prompt, /argue AGAINST the proposition/);
  });

  it("forbids flipping sides or conceding", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 1,
      totalRounds: 3,
      proposition: "X",
      isFinalRound: false,
      transcript: [],
    });
    assert.match(prompt, /Do NOT flip sides/);
    assert.match(prompt, /Do NOT concede/);
  });
});

describe("buildDebaterPrompt — round-aware framing", () => {
  it("mid-debate round tells debater to rebut peer specifically", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 2,
      totalRounds: 4,
      proposition: "X",
      isFinalRound: false,
      transcript: [],
    });
    assert.match(prompt, /round 2 of 4/);
    assert.match(prompt, /Rebut your opponent/i);
  });

  it("final round triggers closing-statement framing", () => {
    const prompt = buildDebaterPrompt({
      side: "con",
      round: 3,
      totalRounds: 3,
      proposition: "X",
      isFinalRound: true,
      transcript: [],
    });
    assert.match(prompt, /FINAL round/);
    assert.match(prompt, /closing statement/i);
  });
});

describe("buildDebaterPrompt — transcript visibility", () => {
  it("labels peer entries as PRO / CON (not Agent 1 / Agent 2) for readability", () => {
    const transcript: TranscriptEntry[] = [
      system("seed"),
      agent(1, "pro round 1 content"),
      agent(2, "con round 1 content"),
    ];
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 2,
      totalRounds: 3,
      proposition: "X",
      isFinalRound: false,
      transcript,
    });
    assert.ok(prompt.includes("[PRO] pro round 1 content"));
    assert.ok(prompt.includes("[CON] con round 1 content"));
  });

  it("handles an empty transcript (round 1, PRO opens)", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 1,
      totalRounds: 3,
      proposition: "X",
      isFinalRound: false,
      transcript: [],
    });
    assert.ok(prompt.includes("(empty — you open the debate)"));
  });
});

describe("buildJudgePrompt", () => {
  it("identifies agent 3 as the judge", () => {
    const prompt = buildJudgePrompt({ proposition: "X", transcript: [] });
    assert.ok(prompt.includes("Agent 3"));
    assert.match(prompt, /JUDGE/);
  });

  it("demands JSON verdict with winner + confidence (Task #81 envelope)", () => {
    const prompt = buildJudgePrompt({ proposition: "X", transcript: [] });
    assert.match(prompt, /"winner": "pro" \| "con" \| "tie"/);
    assert.match(prompt, /"confidence": "low" \| "medium" \| "high"/);
  });

  it("instructs scoring on merits of arguments, not prior beliefs", () => {
    const prompt = buildJudgePrompt({ proposition: "X", transcript: [] });
    assert.match(prompt, /on the MERITS of the arguments/i);
    assert.match(prompt, /not on your prior opinion/i);
  });

  it("renders debater transcript entries as PRO / CON labels", () => {
    const transcript: TranscriptEntry[] = [
      system("seed"),
      agent(1, "pro case ABC"),
      agent(2, "con case XYZ"),
    ];
    const prompt = buildJudgePrompt({ proposition: "X", transcript });
    assert.ok(prompt.includes("[PRO] pro case ABC"));
    assert.ok(prompt.includes("[CON] con case XYZ"));
  });
});

// Task #135: implementer no-op detector. Catches the validation-tour
// failure mode where the implementer talked about edits without making
// any, and the signoff REJECTED.
describe("scanImplementerForNoOp (Task #135)", () => {
  it("flags pure narration with no path citations or CHANGED tags", () => {
    const text =
      "I will read the file and add a new function. After that I should test it. " +
      "I think this is a good approach to take.";
    const r = scanImplementerForNoOp(text);
    assert.equal(r.likelyNoOp, true);
    assert.ok(r.reasons.includes("no CHANGED: tag"));
    assert.ok(r.reasons.includes("no path:line citation"));
  });

  it("passes when CHANGED: tag is present even without path:line", () => {
    const text = "CHANGED: server/src/index.ts:1 — added route\nRATIONALE: ...";
    const r = scanImplementerForNoOp(text);
    assert.equal(r.likelyNoOp, false);
  });

  it("passes when path:line citation is present even without CHANGED tag", () => {
    const text = "I edited src/foo.ts:42 to add the new branch.";
    const r = scanImplementerForNoOp(text);
    assert.equal(r.likelyNoOp, false);
  });

  it("passes for explicit acknowledged no-op", () => {
    const text = "CHANGED: (none — reason: next-action requires a meeting, not code)";
    const r = scanImplementerForNoOp(text);
    assert.equal(r.likelyNoOp, false);
  });

  it("does not count URLs as code-path citations", () => {
    // URL text alone should NOT count as evidence of edits — the regex
    // requires the path to be in a position adjacent to whitespace /
    // backtick / quote / paren AND lacks the `://` scheme. So this
    // text correctly trips the no-op flag.
    const text = "See https://example.com/docs/foo.html:1 for details. Nothing else.";
    const r = scanImplementerForNoOp(text);
    assert.equal(r.likelyNoOp, true);
  });
});

// 2026-05-03 (debate-judge directive lever): directive plumbing tests.

describe("buildDebaterPrompt — directive injection (improvement #2)", () => {
  it("injects 'broader directive' context when set", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 1,
      totalRounds: 3,
      proposition: "We should ship X as a single PR.",
      isFinalRound: false,
      transcript: [],
      userDirective: "Refactor auth to bcrypt.",
    });
    assert.match(prompt, /Broader directive.*Refactor auth to bcrypt\./);
    assert.match(prompt, /how the proposition affects the broader directive/);
  });

  it("falls back to original framing when directive absent", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 1,
      totalRounds: 3,
      proposition: "P",
      isFinalRound: false,
      transcript: [],
    });
    assert.ok(!/Broader directive/.test(prompt));
  });

  it("treats whitespace-only directive as absent", () => {
    const prompt = buildDebaterPrompt({
      side: "pro",
      round: 1,
      totalRounds: 3,
      proposition: "P",
      isFinalRound: false,
      transcript: [],
      userDirective: "   \n\n   ",
    });
    assert.ok(!/Broader directive/.test(prompt));
  });
});

describe("buildJudgePrompt — directive injection (improvement #2)", () => {
  it("when directive set, frames nextAction as concrete step toward the directive", () => {
    const prompt = buildJudgePrompt({
      proposition: "P",
      transcript: [],
      userDirective: "Refactor auth.",
    });
    assert.match(prompt, /Broader directive.*Refactor auth\./);
    assert.match(prompt, /frame it as the concrete next step toward the directive/);
  });

  it("falls back to original framing when directive absent", () => {
    const prompt = buildJudgePrompt({ proposition: "P", transcript: [] });
    assert.ok(!/Broader directive/.test(prompt));
  });
});

describe("buildImplementerPrompt — directive injection", () => {
  it("instructs file edits to advance the directive when set", () => {
    const prompt = buildImplementerPrompt("P", STUB_VERDICT, "Refactor auth.");
    assert.match(prompt, /Broader directive.*Refactor auth\./);
    assert.match(prompt, /file edits should be a concrete step toward the directive/);
  });

  it("preserves the CHANGED:/RATIONALE:/OUT OF SCOPE: report contract in both paths", () => {
    for (const p of [
      buildImplementerPrompt("P", STUB_VERDICT),
      buildImplementerPrompt("P", STUB_VERDICT, "x"),
    ]) {
      assert.match(p, /Required report format/);
      assert.match(p, /CHANGED:/);
      assert.match(p, /RATIONALE:/);
      assert.match(p, /OUT OF SCOPE:/);
    }
  });
});

describe("buildReviewerPrompt — directive injection", () => {
  it("when directive set, asks reviewer to flag superficial fixes that don't advance the directive", () => {
    const prompt = buildReviewerPrompt("P", STUB_VERDICT, [], "Refactor auth.");
    assert.match(prompt, /Broader directive.*Refactor auth\./);
    assert.match(prompt, /flag if the changes only superficially address it/);
  });
});

describe("buildSignoffPrompt — directive injection", () => {
  it("when directive set, asks judge to factor directive-advancement into ACCEPTED/PARTIAL/REJECTED", () => {
    const prompt = buildSignoffPrompt("P", STUB_VERDICT, [], "Refactor auth.");
    assert.match(prompt, /Broader directive.*Refactor auth\./);
    assert.match(prompt, /factor in whether the implementation meaningfully advances the directive/);
  });

  it("preserves ACCEPTED/PARTIAL/REJECTED contract in both paths", () => {
    for (const p of [
      buildSignoffPrompt("P", STUB_VERDICT, []),
      buildSignoffPrompt("P", STUB_VERDICT, [], "x"),
    ]) {
      assert.match(p, /ACCEPTED/);
      assert.match(p, /PARTIAL/);
      assert.match(p, /REJECTED/);
    }
  });
});

// Structural runner wiring + form spec.

describe("DebateJudgeRunner — directive plumbing (structural)", () => {
  it("(#1) start() auto-derives proposition when Proposition empty + directive set", () => {
    assert.match(
      DJ_SRC,
      /this\.proposition === undefined \|\| this\.proposition\.length === 0/,
      "auto-derive must gate on empty proposition",
    );
    assert.match(
      DJ_SRC,
      /deriveProposition\(\{[\s\S]{0,200}?directive: directiveTrimmed/,
      "auto-derive must call deriveProposition with the trimmed directive",
    );
  });

  it("(#2) loop threads cfg.userDirective into runDebaterTurn + runJudgeTurn + runNextActionPhase", () => {
    // T-Item-2 (2026-05-04): the per-round calls moved out of `loop`
    // into runSingleStreamDebate (which both single- and multi-stream
    // paths share). The proposition parameter is now named
    // `proposition` (was `prop` in the inline loop) + a trailing
    // `stream` arg threads the optional DebateStream context.
    assert.match(
      DJ_SRC,
      /this\.runDebaterTurn\(pro, "pro", r, cfg\.rounds, proposition, isFinalRound, cfg\.userDirective, stream\)/,
    );
    assert.match(
      DJ_SRC,
      /this\.runDebaterTurn\(con, "con", r, cfg\.rounds, proposition, isFinalRound, cfg\.userDirective, stream\)/,
    );
    assert.match(
      DJ_SRC,
      /this\.runJudgeTurn\(judge, proposition, r, cfg\.userDirective, stream\)/,
    );
    assert.match(
      DJ_SRC,
      /this\.runNextActionPhase\(pro, con, judge, prop, finalVerdict, cfg\.userDirective\)/,
    );
  });

  it("(#2) build phase callees thread userDirective into all three prompts", () => {
    assert.match(
      DJ_ALL,
      /buildImplementerPrompt\(proposition, verdict, userDirective\)/,
    );
    assert.match(
      DJ_ALL,
      /buildReviewerPrompt\(proposition, verdict, \[\.\.\.this\.transcript\], userDirective\)/,
    );
    assert.match(
      DJ_ALL,
      /buildSignoffPrompt\(proposition, verdict, \[\.\.\.this\.transcript\], userDirective\)/,
    );
  });

  it("(#3 + Phase A) deliverable uses maybeDirectiveSection + pickDeliverableTitle helpers", () => {
    assert.match(DJ_ALL, /maybeDirectiveSection\(dirCtx\)/);
    assert.match(
      DJ_ALL,
      /pickDeliverableTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Debate-judge: directive decision"/,
      "deliverable title must use pickDeliverableTitle helper",
    );
  });

  it("(#3) deliverable labels proposition source (auto-derived / fallback / user-set)", () => {
    assert.match(
      DJ_ALL,
      /Proposition \(auto-derived from directive\)/,
    );
    assert.match(
      DJ_ALL,
      /Proposition \(fallback — auto-derive failed\)/,
    );
  });
});

describe("Debate-judge form spec", () => {
  it("debate-judge is now directive: 'honored'", () => {
    const presetsSrc = readFileSync(
      join(__dirname, "../../../web/src/components/setup/presets.ts"),
      "utf8",
    );
    const block = presetsSrc.match(/id:\s*"debate-judge"[\s\S]{0,2000}?\},/);
    assert.ok(block, "debate-judge preset block must exist");
    assert.match(block![0], /directive:\s*"honored"/);
  });
});
