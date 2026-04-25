import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDebaterPrompt,
  buildJudgePrompt,
  DEFAULT_PROPOSITION,
  scanImplementerForNoOp,
} from "./DebateJudgeRunner.js";
import type { TranscriptEntry } from "../types.js";

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
