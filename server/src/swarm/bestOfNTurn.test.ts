// Q4 (2026-05-04): tests for best-of-N at the turn level.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickBestSampleByLength,
  buildBestOfNJudgePrompt,
  parseBestOfNJudgePick,
  pickBestOfNSample,
} from "./bestOfNTurn.js";

test("pickBestSampleByLength — empty input → null", () => {
  assert.equal(pickBestSampleByLength([]), null);
});

test("pickBestSampleByLength — all-empty samples → null", () => {
  assert.equal(
    pickBestSampleByLength([
      { id: "a", text: "" },
      { id: "b", text: "   " },
    ]),
    null,
  );
});

test("pickBestSampleByLength — longest non-empty wins", () => {
  const got = pickBestSampleByLength([
    { id: "short", text: "hi" },
    { id: "long", text: "this is a longer response with more content" },
    { id: "medium", text: "medium one" },
  ]);
  assert.equal(got?.pickedId, "long");
});

test("pickBestSampleByLength — tie broken by lowest id", () => {
  const got = pickBestSampleByLength([
    { id: "z", text: "abcde" },
    { id: "a", text: "abcde" },
    { id: "m", text: "abcde" },
  ]);
  assert.equal(got?.pickedId, "a");
});

test("buildBestOfNJudgePrompt — includes all samples + brief + JSON shape", () => {
  const prompt = buildBestOfNJudgePrompt({
    taskBrief: "Decide whether feature X is sound",
    samples: [
      { id: "s1", text: "First take" },
      { id: "s2", text: "Second take" },
    ],
  });
  assert.match(prompt, /First take/);
  assert.match(prompt, /Second take/);
  assert.match(prompt, /Decide whether feature X is sound/);
  assert.match(prompt, /pickedIndex/);
  assert.match(prompt, /STRICT JSON/);
});

test("buildBestOfNJudgePrompt — folds rubric in when supplied", () => {
  const prompt = buildBestOfNJudgePrompt({
    taskBrief: "x",
    samples: [{ id: "s", text: "y" }],
    rubric: ["correctness", "specificity"],
  });
  assert.match(prompt, /Rubric/);
  assert.match(prompt, /correctness/);
  assert.match(prompt, /specificity/);
});

test("parseBestOfNJudgePick — strict JSON happy path", () => {
  const samples = [
    { id: "s1", text: "a" },
    { id: "s2", text: "b" },
  ];
  const got = parseBestOfNJudgePick(
    '{"pickedIndex": 1, "rationale": "more specific"}',
    samples,
  );
  assert.equal(got?.pickedId, "s2");
  assert.equal(got?.rationale, "more specific");
});

test("parseBestOfNJudgePick — fenced JSON tolerated", () => {
  const samples = [{ id: "s1", text: "a" }];
  const got = parseBestOfNJudgePick(
    '```json\n{"pickedIndex": 0}\n```',
    samples,
  );
  assert.equal(got?.pickedId, "s1");
});

test("parseBestOfNJudgePick — out-of-range index → null", () => {
  const samples = [{ id: "s", text: "x" }];
  assert.equal(
    parseBestOfNJudgePick('{"pickedIndex": 5}', samples),
    null,
  );
});

test("parseBestOfNJudgePick — non-integer index → null", () => {
  const samples = [{ id: "s", text: "x" }];
  assert.equal(
    parseBestOfNJudgePick('{"pickedIndex": "first"}', samples),
    null,
  );
});

test("pickBestOfNSample — empty samples → null", async () => {
  const got = await pickBestOfNSample({ samples: [], taskBrief: "x" });
  assert.equal(got, null);
});

test("pickBestOfNSample — single non-empty sample → that one", async () => {
  const got = await pickBestOfNSample({
    samples: [{ id: "only", text: "x" }],
    taskBrief: "y",
  });
  assert.equal(got?.pickedId, "only");
});

test("pickBestOfNSample — single empty sample → null", async () => {
  const got = await pickBestOfNSample({
    samples: [{ id: "only", text: "" }],
    taskBrief: "y",
  });
  assert.equal(got, null);
});

test("pickBestOfNSample — judge picks → returned", async () => {
  const got = await pickBestOfNSample({
    samples: [
      { id: "a", text: "shorter answer" },
      { id: "b", text: "longer better answer" },
    ],
    taskBrief: "x",
    judgePicker: async () =>
      JSON.stringify({ pickedIndex: 0, rationale: "more concise" }),
  });
  assert.equal(got?.pickedId, "a");
  assert.equal(got?.rationale, "more concise");
});

test("pickBestOfNSample — judge throws → falls back to length heuristic", async () => {
  const got = await pickBestOfNSample({
    samples: [
      { id: "a", text: "short" },
      { id: "b", text: "longer text wins by length" },
    ],
    taskBrief: "x",
    judgePicker: async () => {
      throw new Error("judge dead");
    },
  });
  assert.equal(got?.pickedId, "b");
});

test("pickBestOfNSample — judge returns garbage → falls back to length heuristic", async () => {
  const got = await pickBestOfNSample({
    samples: [
      { id: "a", text: "short" },
      { id: "b", text: "longer wins by length again" },
    ],
    taskBrief: "x",
    judgePicker: async () => "not json at all",
  });
  assert.equal(got?.pickedId, "b");
});

test("pickBestOfNSample — no judgePicker supplied → length heuristic", async () => {
  const got = await pickBestOfNSample({
    samples: [
      { id: "a", text: "x" },
      { id: "b", text: "longer one" },
    ],
    taskBrief: "y",
  });
  assert.equal(got?.pickedId, "b");
});
