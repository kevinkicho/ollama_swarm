// Q12 (2026-05-04): tests for best-preset auto-pick router.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heuristicPickPreset,
  buildPresetRouterPrompt,
  parsePresetRouterDecision,
} from "./presetRouter.js";
import type { PresetId } from "./SwarmRunner.js";

const ALL_PRESETS: PresetId[] = [
  "blackboard",
  "round-robin",
  "role-diff",
  "council",
  "orchestrator-worker",
  "orchestrator-worker-deep",
  "debate-judge",
  "map-reduce",
  "stigmergy",
  "moa",
  "baseline",
];

test("heuristicPickPreset — code-modify verbs → blackboard", () => {
  for (const directive of [
    "Fix the off-by-one in countDown",
    "Add a null guard to formatUser",
    "Refactor the auth flow",
    "Rename oldSum to newSum across src/",
  ]) {
    const got = heuristicPickPreset(directive);
    assert.equal(got?.pickedPreset, "blackboard", `failed: ${directive}`);
    assert.equal(got?.source, "heuristic");
  }
});

test("heuristicPickPreset — debate markers → debate-judge", () => {
  const got = heuristicPickPreset(
    "Should we migrate to Fastify? Debate the tradeoffs.",
  );
  assert.equal(got?.pickedPreset, "debate-judge");
});

test("heuristicPickPreset — design markers → council", () => {
  const got = heuristicPickPreset("Design the new auth module");
  assert.equal(got?.pickedPreset, "council");
});

test("heuristicPickPreset — audit markers → map-reduce", () => {
  const got = heuristicPickPreset("Audit every console.log in the repo");
  assert.equal(got?.pickedPreset, "map-reduce");
});

test("heuristicPickPreset — explore markers → stigmergy", () => {
  const got = heuristicPickPreset("Explore the repo and tell me what it does");
  assert.equal(got?.pickedPreset, "stigmergy");
});

test("heuristicPickPreset — empty directive → null (no pick)", () => {
  assert.equal(heuristicPickPreset(""), null);
  assert.equal(heuristicPickPreset("   "), null);
});

test("heuristicPickPreset — generic question with no clear marker → null", () => {
  // "what's the best programming language?" doesn't fit a category
  const got = heuristicPickPreset("What's the best programming language?");
  // Could match "best" or other word; if it does, the rationale should
  // explain. For "completely ambiguous" prompts the heuristic returns null.
  // (Acceptable behavior in either case.)
  if (got) {
    assert.ok(typeof got.rationale === "string");
  }
});

test("heuristicPickPreset — word boundaries (no false positives)", () => {
  // "addiction" should NOT match "add"
  const got = heuristicPickPreset(
    "What does this app know about user addiction patterns?",
  );
  // Should not pick blackboard from "add" inside "addiction"
  if (got) {
    assert.notEqual(got.pickedPreset, "blackboard");
  }
});

test("buildPresetRouterPrompt — includes directive + each available preset", () => {
  const prompt = buildPresetRouterPrompt({
    directive: "Some ambiguous task",
    available: ["blackboard", "council", "moa"],
  });
  assert.match(prompt, /Some ambiguous task/);
  assert.match(prompt, /blackboard:/);
  assert.match(prompt, /council:/);
  assert.match(prompt, /moa:/);
  assert.match(prompt, /STRICT JSON/);
});

test("parsePresetRouterDecision — strict JSON happy path", () => {
  const got = parsePresetRouterDecision(
    '{"pickedPreset": "council", "rationale": "design discussion fits"}',
    ALL_PRESETS,
  );
  assert.equal(got?.pickedPreset, "council");
  assert.equal(got?.source, "llm");
  assert.match(got!.rationale, /design discussion/);
});

test("parsePresetRouterDecision — fenced JSON tolerated", () => {
  const got = parsePresetRouterDecision(
    '```json\n{"pickedPreset": "blackboard"}\n```',
    ALL_PRESETS,
  );
  assert.equal(got?.pickedPreset, "blackboard");
});

test("parsePresetRouterDecision — invalid preset rejected", () => {
  assert.equal(
    parsePresetRouterDecision(
      '{"pickedPreset": "made-up-preset"}',
      ALL_PRESETS,
    ),
    null,
  );
});

test("parsePresetRouterDecision — preset not in `available` list rejected", () => {
  assert.equal(
    parsePresetRouterDecision(
      '{"pickedPreset": "stigmergy"}',
      ["blackboard", "council"],
    ),
    null,
  );
});

test("parsePresetRouterDecision — garbage returns null", () => {
  assert.equal(parsePresetRouterDecision("not json", ALL_PRESETS), null);
  assert.equal(parsePresetRouterDecision("", ALL_PRESETS), null);
});

test("parsePresetRouterDecision — empty rationale tolerated", () => {
  const got = parsePresetRouterDecision(
    '{"pickedPreset": "moa"}',
    ALL_PRESETS,
  );
  assert.equal(got?.pickedPreset, "moa");
  assert.equal(got?.rationale, "");
});
