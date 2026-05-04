// #91 (2026-05-01): structural tests for jsonSchemas.ts.
//
// We don't use a JSON-Schema validator at runtime (the parsers next door
// already do zod-level validation; the JSON Schema constants are for
// Ollama's `format` decoder constraint, which Ollama validates server-
// side). These tests just make sure the constants stay structurally
// well-formed and stay in sync with the zod schemas next door.
//
// Specifically: pick a known-good payload that the corresponding zod
// parser accepts, and verify the JSON Schema matches the same SHAPE
// (field names, required-ness, type primitives). If a zod schema gains
// a field, this test catches the JSON Schema drifting.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_JSON_SCHEMA,
  PLANNER_TODOS_JSON_SCHEMA,
  AUDITOR_VERDICT_JSON_SCHEMA,
  CRITIC_ENVELOPE_JSON_SCHEMA,
  WORKER_HUNKS_JSON_SCHEMA,
  REPLANNER_JSON_SCHEMA,
} from "./jsonSchemas.js";
import { parseFirstPassContractResponse } from "./firstPassContract.js";
import { parsePlannerResponse } from "./planner.js";
import { parseAuditorResponse } from "./auditor.js";
import { parseCriticResponse } from "./critic.js";
import { parseWorkerResponse } from "./worker.js";
import { parseReplannerResponse } from "./replanner.js";

// ---------------------------------------------------------------------------
// Cross-check: a payload that the zod parser ACCEPTS should also have
// every field claimed required by the JSON Schema. Catches drift the
// other way (zod loosened, JSON Schema not).
// ---------------------------------------------------------------------------

test("CONTRACT_JSON_SCHEMA — valid contract parses + matches required fields", () => {
  const payload = {
    missionStatement: "Make the README correct.",
    criteria: [
      { description: "README mentions ten patterns", expectedFiles: ["README.md"] },
    ],
  };
  const parsed = parseFirstPassContractResponse(JSON.stringify(payload));
  assert.equal(parsed.ok, true);
  assert.deepEqual(CONTRACT_JSON_SCHEMA.required, ["missionStatement", "criteria"]);
  assert.equal(CONTRACT_JSON_SCHEMA.properties.missionStatement.maxLength, 500);
  assert.equal(CONTRACT_JSON_SCHEMA.properties.criteria.maxItems, 12);
});

test("PLANNER_TODOS_JSON_SCHEMA — both hunks + build variants match parser", () => {
  // hunks variant
  const hunksPayload = [
    { description: "Fix off-by-one", expectedFiles: ["src/x.ts"] },
  ];
  const hunksParsed = parsePlannerResponse(JSON.stringify(hunksPayload));
  assert.equal(hunksParsed.ok, true);

  // build variant
  const buildPayload = [
    { kind: "build", description: "Run docs", expectedFiles: ["docs/index.html"], command: "npm run docs" },
  ];
  const buildParsed = parsePlannerResponse(JSON.stringify(buildPayload));
  assert.equal(buildParsed.ok, true);

  // Schema shape
  assert.equal(PLANNER_TODOS_JSON_SCHEMA.type, "array");
  assert.equal(PLANNER_TODOS_JSON_SCHEMA.maxItems, 5, "matches MAX_TODOS_PER_BATCH");
  // The discriminated union — at least 2 variants present
  const variants = PLANNER_TODOS_JSON_SCHEMA.items.oneOf;
  assert.equal(variants.length, 2, "hunks + build variants");
  // Build variant requires command + kind
  const buildRequired = variants[1].required as readonly string[];
  assert.ok(buildRequired.includes("command"));
  assert.ok(buildRequired.includes("kind"));
  // Hunks variant doesn't require command
  const hunksRequired = variants[0].required as readonly string[];
  assert.ok(!hunksRequired.includes("command"));
});

test("AUDITOR_VERDICT_JSON_SCHEMA — valid verdict envelope parses + matches schema", () => {
  const payload = {
    verdicts: [
      { id: "c1", status: "met", rationale: "All criteria satisfied." },
      { id: "c2", status: "unmet", rationale: "File missing.", todos: [{ description: "Create file", expectedFiles: ["x.ts"] }] },
    ],
  };
  const parsed = parseAuditorResponse(JSON.stringify(payload));
  assert.equal(parsed.ok, true);
  assert.deepEqual(AUDITOR_VERDICT_JSON_SCHEMA.required, ["verdicts"]);
  // Status enum matches zod
  const statusEnum = AUDITOR_VERDICT_JSON_SCHEMA.properties.verdicts.items.properties.status.enum;
  assert.deepEqual([...statusEnum].sort(), ["met", "unmet", "wont-do"]);
  // Verdicts cap matches the zod max of 20
  assert.equal(AUDITOR_VERDICT_JSON_SCHEMA.properties.verdicts.maxItems, 20);
});

test("CRITIC_ENVELOPE_JSON_SCHEMA — both verdicts (accept/reject) parse", () => {
  const acceptPayload = { verdict: "accept", rationale: "Diff is correct." };
  const rejectPayload = { verdict: "reject", rationale: "Tests don't actually exercise the bug." };
  assert.equal(parseCriticResponse(JSON.stringify(acceptPayload)).ok, true);
  assert.equal(parseCriticResponse(JSON.stringify(rejectPayload)).ok, true);
  assert.deepEqual([...CRITIC_ENVELOPE_JSON_SCHEMA.required].sort(), ["rationale", "verdict"]);
  assert.deepEqual(
    [...CRITIC_ENVELOPE_JSON_SCHEMA.properties.verdict.enum].sort(),
    ["accept", "reject"],
  );
});

// ---------------------------------------------------------------------------
// Negative checks: schema's required list should NOT claim a field as
// required if zod allows it to be optional. (e.g. AuditorVerdict.todos
// is optional, NOT required.)
// ---------------------------------------------------------------------------

test("AUDITOR_VERDICT_JSON_SCHEMA — todos is optional in verdict items", () => {
  const verdictItem = AUDITOR_VERDICT_JSON_SCHEMA.properties.verdicts.items;
  // Cast to string[] because the readonly literal-typed required tuple
  // narrows .includes() to only literally-listed values; we want to
  // assert NEGATIVE membership (todos NOT in the list), which TS treats
  // as a type-error otherwise.
  const required = verdictItem.required as readonly string[];
  assert.ok(!required.includes("todos"), "todos must NOT be required (zod has .optional())");
  assert.ok(required.includes("id"));
  assert.ok(required.includes("status"));
  assert.ok(required.includes("rationale"));
});

test("AUDITOR_VERDICT_JSON_SCHEMA — newCriteria is optional at envelope level", () => {
  const required = AUDITOR_VERDICT_JSON_SCHEMA.required as readonly string[];
  assert.ok(!required.includes("newCriteria"));
});

test("PLANNER_TODOS_JSON_SCHEMA — expectedAnchors + expectedSymbols + preferredTag optional in both variants", () => {
  for (const variant of PLANNER_TODOS_JSON_SCHEMA.items.oneOf) {
    const required = variant.required as readonly string[];
    assert.ok(!required.includes("expectedAnchors"));
    assert.ok(!required.includes("expectedSymbols"));
    assert.ok(!required.includes("preferredTag"));
  }
});

// #96 (2026-05-01): WORKER_HUNKS schema cross-checks. Worker is the
// highest-frequency parse-failure path — coverage here matters most.

test("WORKER_HUNKS_JSON_SCHEMA — replace hunk parses + matches schema", () => {
  const payload = {
    hunks: [{ op: "replace", file: "src/x.ts", search: "old", replace: "new" }],
  };
  const parsed = parseWorkerResponse(JSON.stringify(payload), ["src/x.ts"]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(WORKER_HUNKS_JSON_SCHEMA.required, ["hunks"]);
  assert.equal(WORKER_HUNKS_JSON_SCHEMA.properties.hunks.maxItems, 8, "matches MAX_HUNKS");
});

test("WORKER_HUNKS_JSON_SCHEMA — create hunk parses + schema variant present", () => {
  const payload = {
    hunks: [{ op: "create", file: "src/new.ts", content: "export const x = 1;\n" }],
  };
  const parsed = parseWorkerResponse(JSON.stringify(payload), ["src/new.ts"]);
  assert.equal(parsed.ok, true);
  // Find the create variant in the oneOf
  const variants = WORKER_HUNKS_JSON_SCHEMA.properties.hunks.items.oneOf;
  const createVariant = variants.find((v) =>
    ([...v.properties.op.enum] as string[]).includes("create"),
  );
  assert.ok(createVariant, "create variant must exist in oneOf");
  assert.deepEqual([...createVariant.required].sort(), ["content", "file", "op"]);
});

test("WORKER_HUNKS_JSON_SCHEMA — append hunk parses + schema variant present", () => {
  const payload = {
    hunks: [{ op: "append", file: "CHANGELOG.md", content: "- new entry\n" }],
  };
  const parsed = parseWorkerResponse(JSON.stringify(payload), ["CHANGELOG.md"]);
  assert.equal(parsed.ok, true);
  const variants = WORKER_HUNKS_JSON_SCHEMA.properties.hunks.items.oneOf;
  const appendVariant = variants.find((v) =>
    ([...v.properties.op.enum] as string[]).includes("append"),
  );
  assert.ok(appendVariant, "append variant must exist in oneOf");
});

test("WORKER_HUNKS_JSON_SCHEMA — skip-only response (no hunks beyond empty)", () => {
  const payload = {
    hunks: [],
    skip: "Cannot find the function described in the todo",
  };
  const parsed = parseWorkerResponse(JSON.stringify(payload), ["src/x.ts"]);
  assert.equal(parsed.ok, true);
  // skip is optional in the schema (zod has .optional())
  const required = WORKER_HUNKS_JSON_SCHEMA.required as readonly string[];
  assert.ok(!required.includes("skip"), "skip must be optional");
});

test("WORKER_HUNKS_JSON_SCHEMA — three variants in oneOf", () => {
  const variants = WORKER_HUNKS_JSON_SCHEMA.properties.hunks.items.oneOf;
  assert.equal(variants.length, 3, "replace + create + append");
  const ops = variants.map((v) => ([...v.properties.op.enum] as string[])[0]);
  assert.deepEqual([...ops].sort(), ["append", "create", "replace"]);
});

test("REPLANNER_JSON_SCHEMA — revise variant parses + matches schema", () => {
  const revisePayload = {
    revised: {
      description: "Fix the off-by-one in the counter",
      expectedFiles: ["src/counter.ts"],
    },
  };
  const parsed = parseReplannerResponse(JSON.stringify(revisePayload));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.action, "revised");
  const variants = REPLANNER_JSON_SCHEMA.oneOf;
  assert.equal(variants.length, 2, "revised + skip variants");
  const revisedVariant = variants[0];
  assert.deepEqual([...revisedVariant.required], ["revised"]);
  assert.deepEqual([...revisedVariant.properties.revised.required].sort(), ["description", "expectedFiles"]);
});

test("REPLANNER_JSON_SCHEMA — skip variant parses + matches schema", () => {
  const skipPayload = { skip: true, reason: "Already done by another agent" };
  const parsed = parseReplannerResponse(JSON.stringify(skipPayload));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.action, "skip");
  const skipVariant = REPLANNER_JSON_SCHEMA.oneOf[1];
  assert.deepEqual([...skipVariant.required].sort(), ["reason", "skip"]);
  assert.deepEqual([...skipVariant.properties.skip.enum], [true]);
});

test("REPLANNER_JSON_SCHEMA — build-style revision (kind: build)", () => {
  const buildPayload = {
    revised: {
      kind: "build",
      description: "Run lint fix",
      expectedFiles: ["src/x.ts"],
      command: "npm run lint --fix",
    },
  };
  const parsed = parseReplannerResponse(JSON.stringify(buildPayload));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.action, "revised");
  assert.equal(parsed.kind, "build");
  assert.equal(parsed.command, "npm run lint --fix");
});

test("REPLANNER_JSON_SCHEMA — expectedAnchors is optional in revised branch", () => {
  const revisedProps = REPLANNER_JSON_SCHEMA.oneOf[0].properties.revised;
  const required = revisedProps.required as readonly string[];
  assert.ok(!required.includes("expectedAnchors"), "expectedAnchors must be optional");
  assert.ok(!required.includes("command"), "command must be optional (only required for kind:build)");
  assert.ok(!required.includes("kind"), "kind must be optional (defaults to hunks)");
});
