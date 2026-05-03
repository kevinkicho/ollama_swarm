// 2026-05-03 (debate-judge improvement #1): tests for the proposition
// auto-derive helper. Pure-function tests; the runner wiring is
// covered structurally in DebateJudgeRunner.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPropositionDerivationPrompt,
  parseDerivedProposition,
  fallbackProposition,
} from "./propositionDerive.js";

describe("buildPropositionDerivationPrompt", () => {
  it("includes the directive verbatim", () => {
    const prompt = buildPropositionDerivationPrompt("Refactor auth to bcrypt.");
    assert.match(prompt, /Refactor auth to bcrypt\./);
  });

  it("requires JSON output with proposition + rationale fields", () => {
    const prompt = buildPropositionDerivationPrompt("x");
    assert.match(prompt, /"proposition"/);
    assert.match(prompt, /"rationale"/);
    assert.match(prompt, /Output ONLY a JSON object/);
  });

  it("explicitly instructs to avoid strawmen and vague restatements", () => {
    const prompt = buildPropositionDerivationPrompt("x");
    assert.match(prompt, /admit REAL disagreement/);
    assert.match(prompt, /Avoid strawmen/);
  });

  it("includes a worked example to anchor the model", () => {
    const prompt = buildPropositionDerivationPrompt("x");
    assert.match(prompt, /Worked example/);
    assert.match(prompt, /bcrypt migration/);
  });
});

describe("parseDerivedProposition", () => {
  it("returns null on empty input", () => {
    assert.equal(parseDerivedProposition(""), null);
    assert.equal(parseDerivedProposition("   \n\n   "), null);
  });

  it("returns null on unparseable input", () => {
    assert.equal(parseDerivedProposition("not json at all"), null);
  });

  it("parses a clean JSON object", () => {
    const raw = '{"proposition": "We should ship X as a single PR.", "rationale": "minimizes context-switch"}';
    const out = parseDerivedProposition(raw);
    assert.ok(out);
    assert.equal(out!.proposition, "We should ship X as a single PR.");
    assert.equal(out!.rationale, "minimizes context-switch");
    assert.equal(out!.derived, true);
  });

  it("strips a ```json fence before parsing", () => {
    const raw = '```json\n{"proposition": "P", "rationale": "R"}\n```';
    const out = parseDerivedProposition(raw);
    assert.ok(out);
    assert.equal(out!.proposition, "P");
  });

  it("slices the first JSON object out of surrounding prose", () => {
    const raw = 'Here is my answer:\n{"proposition": "P", "rationale": "R"}\nHope that helps.';
    const out = parseDerivedProposition(raw);
    assert.ok(out);
    assert.equal(out!.proposition, "P");
  });

  it("returns null when the proposition field is missing or empty", () => {
    assert.equal(parseDerivedProposition('{"rationale": "R"}'), null);
    assert.equal(parseDerivedProposition('{"proposition": "", "rationale": "R"}'), null);
    assert.equal(parseDerivedProposition('{"proposition": "   "}'), null);
  });

  it("tolerates missing rationale (treats as empty string)", () => {
    const out = parseDerivedProposition('{"proposition": "P"}');
    assert.ok(out);
    assert.equal(out!.proposition, "P");
    assert.equal(out!.rationale, "");
  });

  it("trims whitespace from proposition + rationale", () => {
    const out = parseDerivedProposition('{"proposition": "  P  ", "rationale": "  R  "}');
    assert.ok(out);
    assert.equal(out!.proposition, "P");
    assert.equal(out!.rationale, "R");
  });
});

describe("fallbackProposition", () => {
  it("produces a syntactically-valid pass-through proposition", () => {
    const out = fallbackProposition("Refactor auth.");
    assert.equal(out.proposition, "We should pursue: Refactor auth.");
    assert.equal(out.derived, false);
    assert.match(out.rationale, /auto-derivation failed/);
  });

  it("trims the directive before embedding", () => {
    const out = fallbackProposition("   Refactor auth.   ");
    assert.equal(out.proposition, "We should pursue: Refactor auth.");
  });
});
