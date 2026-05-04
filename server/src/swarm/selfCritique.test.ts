// Q1 (2026-05-04): tests for self-critique helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelfCritiquePrompt,
  parseSelfCritiqueResponse,
  pickPostCritiqueOutput,
} from "./selfCritique.js";

test("buildSelfCritiquePrompt — includes the original output + brief", () => {
  const prompt = buildSelfCritiquePrompt({
    originalOutput: "I think this might possibly work.",
    taskBrief: "Decide if approach X is sound.",
  });
  assert.match(prompt, /I think this might possibly work\./);
  assert.match(prompt, /Decide if approach X is sound\./);
  assert.match(prompt, /Critique checklist/);
  assert.match(prompt, /Output STRICT JSON/);
});

test("buildSelfCritiquePrompt — folds in custom checks when provided", () => {
  const prompt = buildSelfCritiquePrompt({
    originalOutput: "x",
    taskBrief: "y",
    customChecks: ["Did you cite a file:line?", "Did you bound the scope?"],
  });
  assert.match(prompt, /Task-specific checks/);
  assert.match(prompt, /Did you cite a file:line\?/);
  assert.match(prompt, /Did you bound the scope\?/);
});

test("buildSelfCritiquePrompt — omits custom checks block when empty", () => {
  const prompt = buildSelfCritiquePrompt({
    originalOutput: "x",
    taskBrief: "y",
    customChecks: [],
  });
  assert.equal(prompt.includes("Task-specific checks"), false);
});

test("parseSelfCritiqueResponse — strict JSON happy path", () => {
  const got = parseSelfCritiqueResponse(
    JSON.stringify({
      verdict: "minor-revisions",
      issues: [{ category: "hedging", detail: "Used 'might' twice" }],
      refined: "I commit to approach X because Y.",
    }),
  );
  assert.ok(got);
  assert.equal(got!.verdict, "minor-revisions");
  assert.equal(got!.issues.length, 1);
  assert.equal(got!.issues[0].category, "hedging");
  assert.match(got!.refined, /commit to approach X/);
});

test("parseSelfCritiqueResponse — fenced JSON tolerated", () => {
  const got = parseSelfCritiqueResponse(
    '```json\n{"verdict": "ship-as-is", "issues": [], "refined": ""}\n```',
  );
  assert.equal(got?.verdict, "ship-as-is");
});

test("parseSelfCritiqueResponse — invalid verdict rejected", () => {
  assert.equal(
    parseSelfCritiqueResponse(
      '{"verdict": "looks-fine", "issues": [], "refined": ""}',
    ),
    null,
  );
});

test("parseSelfCritiqueResponse — invalid category in issues filtered out", () => {
  const got = parseSelfCritiqueResponse(
    JSON.stringify({
      verdict: "minor-revisions",
      issues: [
        { category: "vibes", detail: "feels off" },
        { category: "hedging", detail: "Used 'might'" },
      ],
      refined: "x",
    }),
  );
  assert.ok(got);
  assert.equal(got!.issues.length, 1);
  assert.equal(got!.issues[0].category, "hedging");
});

test("parseSelfCritiqueResponse — empty / garbage returns null", () => {
  assert.equal(parseSelfCritiqueResponse(""), null);
  assert.equal(parseSelfCritiqueResponse("not json"), null);
});

test("parseSelfCritiqueResponse — JSON embedded in surrounding prose", () => {
  const got = parseSelfCritiqueResponse(
    'Here is my critique:\n{"verdict": "ship-as-is", "issues": [], "refined": ""}\nDone.',
  );
  assert.equal(got?.verdict, "ship-as-is");
});

test("pickPostCritiqueOutput — null verdict → original", () => {
  const got = pickPostCritiqueOutput({
    original: "x",
    verdict: null,
  });
  assert.equal(got.output, "x");
  assert.equal(got.replaced, false);
});

test("pickPostCritiqueOutput — ship-as-is → original (refined ignored)", () => {
  const got = pickPostCritiqueOutput({
    original: "x",
    verdict: { verdict: "ship-as-is", issues: [], refined: "y" },
  });
  assert.equal(got.output, "x");
  assert.equal(got.replaced, false);
});

test("pickPostCritiqueOutput — minor-revisions + non-empty refined → refined", () => {
  const got = pickPostCritiqueOutput({
    original: "x",
    verdict: { verdict: "minor-revisions", issues: [], refined: "y" },
  });
  assert.equal(got.output, "y");
  assert.equal(got.replaced, true);
});

test("pickPostCritiqueOutput — major-revisions + empty refined → original (defensive)", () => {
  // If the model says "major-revisions" but doesn't supply a refined
  // version, we ship the original rather than nothing.
  const got = pickPostCritiqueOutput({
    original: "x",
    verdict: { verdict: "major-revisions", issues: [], refined: "" },
  });
  assert.equal(got.output, "x");
  assert.equal(got.replaced, false);
});
