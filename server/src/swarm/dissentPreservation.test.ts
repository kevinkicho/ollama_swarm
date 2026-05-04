// Q5 (2026-05-04): tests for dissent-preservation synthesis helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDissentSynthesisPrompt,
  parseDissentSynthesis,
  renderDissentSynthesisMarkdown,
} from "./dissentPreservation.js";

test("buildDissentSynthesisPrompt — includes question + drafts + JSON shape", () => {
  const prompt = buildDissentSynthesisPrompt({
    question: "Should we migrate to Fastify?",
    drafts: [
      { agentIndex: 1, text: "Yes, performance wins" },
      { agentIndex: 2, text: "No, ecosystem maturity matters more" },
    ],
  });
  assert.match(prompt, /Should we migrate to Fastify/);
  assert.match(prompt, /Yes, performance wins/);
  assert.match(prompt, /No, ecosystem maturity matters more/);
  assert.match(prompt, /majorityView/);
  assert.match(prompt, /minorityReport/);
  assert.match(prompt, /openQuestions/);
  assert.match(prompt, /STRICT JSON/);
});

test("buildDissentSynthesisPrompt — folds in user directive when present", () => {
  const prompt = buildDissentSynthesisPrompt({
    question: "x",
    drafts: [],
    userDirective: "Improve API throughput",
  });
  assert.match(prompt, /User directive: Improve API throughput/);
});

test("parseDissentSynthesis — strict JSON happy path", () => {
  const got = parseDissentSynthesis(
    JSON.stringify({
      majorityView: "Most agreed Fastify wins on perf",
      minorityReport: "Agent 3 argued ecosystem maturity is undervalued",
      openQuestions: ["What's the migration cost?"],
    }),
  );
  assert.ok(got);
  assert.match(got!.majorityView, /perf/);
  assert.match(got!.minorityReport, /Agent 3/);
  assert.equal(got!.openQuestions.length, 1);
});

test("parseDissentSynthesis — fenced JSON tolerated", () => {
  const got = parseDissentSynthesis(
    '```json\n{"majorityView": "x", "minorityReport": "y", "openQuestions": []}\n```',
  );
  assert.equal(got?.majorityView, "x");
});

test("parseDissentSynthesis — missing majorityView → null (defensive)", () => {
  assert.equal(
    parseDissentSynthesis(
      JSON.stringify({
        minorityReport: "x",
        openQuestions: [],
      }),
    ),
    null,
  );
});

test("parseDissentSynthesis — missing minorityReport → null (the whole point)", () => {
  // Without a minority section the lever has no value — better to
  // fall back to the legacy single-consolidated path.
  assert.equal(
    parseDissentSynthesis(
      JSON.stringify({
        majorityView: "x",
        openQuestions: [],
      }),
    ),
    null,
  );
});

test("parseDissentSynthesis — non-string openQuestions filtered out", () => {
  const got = parseDissentSynthesis(
    JSON.stringify({
      majorityView: "x",
      minorityReport: "y",
      openQuestions: ["valid", 123, null, "also valid"],
    }),
  );
  assert.deepEqual(got?.openQuestions, ["valid", "also valid"]);
});

test("parseDissentSynthesis — garbage → null", () => {
  assert.equal(parseDissentSynthesis("not json"), null);
  assert.equal(parseDissentSynthesis(""), null);
});

test("renderDissentSynthesisMarkdown — three sections rendered in order", () => {
  const md = renderDissentSynthesisMarkdown({
    majorityView: "M",
    minorityReport: "Min",
    openQuestions: ["q1", "q2"],
  });
  assert.match(md, /## Majority view\n\nM/);
  assert.match(md, /## Minority report\n\nMin/);
  assert.match(md, /## Open questions\n\n- q1\n- q2/);
});

test("renderDissentSynthesisMarkdown — open questions section omitted when empty", () => {
  const md = renderDissentSynthesisMarkdown({
    majorityView: "M",
    minorityReport: "Min",
    openQuestions: [],
  });
  assert.equal(md.includes("Open questions"), false);
});
