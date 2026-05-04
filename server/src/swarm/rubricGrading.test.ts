// Q13 (2026-05-04): tests for per-preset rubric grading helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRubricForPreset,
  buildRubricGradingPrompt,
  parseRubricGrade,
  rubricToMarkdownTable,
} from "./rubricGrading.js";

test("defaultRubricForPreset — universal rubric for round-robin / role-diff / etc.", () => {
  const got = defaultRubricForPreset("round-robin");
  const ids = got.map((r) => r.id);
  assert.deepEqual(ids, ["correctness", "completeness", "specificity", "actionability", "format"]);
});

test("defaultRubricForPreset — blackboard adds verify-pass dimension", () => {
  const got = defaultRubricForPreset("blackboard");
  const ids = got.map((r) => r.id);
  assert.ok(ids.includes("verify-pass"));
  assert.equal(ids.length, 6);
});

test("defaultRubricForPreset — debate-judge adds evidence-density dimension", () => {
  const got = defaultRubricForPreset("debate-judge");
  const ids = got.map((r) => r.id);
  assert.ok(ids.includes("evidence-density"));
});

test("buildRubricGradingPrompt — includes directive + run output + rubric items", () => {
  const rubric = defaultRubricForPreset("council");
  const prompt = buildRubricGradingPrompt({
    directive: "Decide whether to migrate to Fastify",
    runOutput: "We recommend staying with Express because…",
    preset: "council",
    rubric,
  });
  assert.match(prompt, /Decide whether to migrate to Fastify/);
  assert.match(prompt, /staying with Express/);
  assert.match(prompt, /correctness/);
  assert.match(prompt, /completeness/);
  assert.match(prompt, /STRICT JSON/);
  assert.match(prompt, /verdict/);
});

test("buildRubricGradingPrompt — truncates very long run output", () => {
  const long = "x".repeat(20_000);
  const prompt = buildRubricGradingPrompt({
    directive: "x",
    runOutput: long,
    preset: "round-robin",
    rubric: defaultRubricForPreset("round-robin"),
  });
  // Output should be capped at ~6000 chars
  const xCount = (prompt.match(/x/g) || []).length;
  assert.ok(xCount <= 6500, `expected ~6000 x's, got ${xCount}`);
});

test("parseRubricGrade — strict JSON happy path", () => {
  const rubric = defaultRubricForPreset("round-robin");
  const got = parseRubricGrade(
    JSON.stringify({
      scores: {
        correctness: 8,
        completeness: 7,
        specificity: 6,
        actionability: 9,
        format: 8,
      },
      notes: {
        correctness: "matches the directive",
        completeness: "skipped subpart X",
        specificity: "could cite more files",
        actionability: "clear next steps",
        format: "well-structured",
      },
      verdict: "ship-quality",
    }),
    rubric,
  );
  assert.ok(got);
  assert.equal(got!.verdict, "ship-quality");
  assert.equal(got!.scores.correctness, 8);
  // Overall = (8+7+6+9+8)/5 = 7.6
  assert.equal(got!.overall, 7.6);
});

test("parseRubricGrade — fenced JSON tolerated", () => {
  const got = parseRubricGrade(
    JSON.stringify({
      scores: { correctness: 5, completeness: 5, specificity: 5, actionability: 5, format: 5 },
      notes: { correctness: "", completeness: "", specificity: "", actionability: "", format: "" },
      verdict: "needs-revision",
    }).replace(/^/, "```json\n").concat("\n```"),
    defaultRubricForPreset("round-robin"),
  );
  assert.equal(got?.overall, 5);
});

test("parseRubricGrade — clamps scores into [0, 10]", () => {
  const got = parseRubricGrade(
    JSON.stringify({
      scores: { correctness: 15, completeness: -5, specificity: 5, actionability: 5, format: 5 },
      notes: { correctness: "", completeness: "", specificity: "", actionability: "", format: "" },
      verdict: "needs-revision",
    }),
    defaultRubricForPreset("round-robin"),
  );
  assert.equal(got?.scores.correctness, 10);
  assert.equal(got?.scores.completeness, 0);
});

test("parseRubricGrade — invalid verdict rejected", () => {
  assert.equal(
    parseRubricGrade(
      JSON.stringify({
        scores: { correctness: 5, completeness: 5, specificity: 5, actionability: 5, format: 5 },
        notes: {},
        verdict: "okay-i-guess",
      }),
      defaultRubricForPreset("round-robin"),
    ),
    null,
  );
});

test("parseRubricGrade — missing scores → null", () => {
  assert.equal(
    parseRubricGrade(
      JSON.stringify({
        scores: {}, // empty
        notes: {},
        verdict: "ship-quality",
      }),
      defaultRubricForPreset("round-robin"),
    ),
    null,
  );
});

test("parseRubricGrade — non-numeric score skipped (not crash)", () => {
  const got = parseRubricGrade(
    JSON.stringify({
      scores: {
        correctness: "high",
        completeness: 7,
        specificity: 7,
        actionability: 7,
        format: 7,
      },
      notes: {},
      verdict: "ship-quality",
    }),
    defaultRubricForPreset("round-robin"),
  );
  assert.ok(got);
  // correctness should be missing from scores; others present
  assert.equal(got!.scores.correctness, undefined);
  assert.equal(got!.scores.completeness, 7);
});

test("parseRubricGrade — garbage returns null", () => {
  assert.equal(parseRubricGrade("not json", defaultRubricForPreset("round-robin")), null);
  assert.equal(parseRubricGrade("", defaultRubricForPreset("round-robin")), null);
});

test("rubricToMarkdownTable — renders verdict + per-dimension rows", () => {
  const rubric = defaultRubricForPreset("round-robin");
  const md = rubricToMarkdownTable({
    grade: {
      scores: {
        correctness: 8,
        completeness: 7,
        specificity: 6,
        actionability: 9,
        format: 8,
      },
      notes: {
        correctness: "good",
        completeness: "missed X",
        specificity: "more cites",
        actionability: "clear",
        format: "well-structured",
      },
      overall: 7.6,
      verdict: "ship-quality",
    },
    rubric,
  });
  assert.match(md, /\*\*Verdict:\*\* SHIP-QUALITY/);
  assert.match(md, /\*\*Overall:\*\* 7\.6\/10/);
  assert.match(md, /\| Correctness \| 8\/10 \| good \|/);
  assert.match(md, /\| Format \| 8\/10 \| well-structured \|/);
});

test("rubricToMarkdownTable — handles dimensions missing from grade.scores", () => {
  const rubric = defaultRubricForPreset("round-robin");
  const md = rubricToMarkdownTable({
    grade: {
      scores: { correctness: 8 }, // only one of the dimensions present
      notes: { correctness: "good" },
      overall: 8,
      verdict: "ship-quality",
    },
    rubric,
  });
  // Should render only the dimensions that have scores
  assert.match(md, /Correctness/);
  assert.equal(md.includes("| Format |"), false);
});
