import { test } from "node:test";
import assert from "node:assert/strict";
import {
  councilExecutionTier,
  MAX_COUNCIL_TODOS_PER_BATCH,
  mergeOverlappingCouncilTodos,
  prepareCouncilTodoBatch,
  scoreCouncilTodoForDequeue,
  sortCouncilTodosByTier,
} from "./councilTodoPlan.js";

test("councilExecutionTier — build commands last tier", () => {
  assert.equal(
    councilExecutionTier("Run pytest on tests/", ["tests/test_foo.py"]),
    "build",
  );
});

test("councilExecutionTier — tests before docs", () => {
  assert.equal(councilExecutionTier("Add unit tests", ["tests/test_a.py"]), "test");
  assert.equal(councilExecutionTier("Update strategy", ["discovery_strategy.md"]), "docs");
  assert.equal(councilExecutionTier("Implement predictor", ["scripts/predict_tc.py"]), "impl");
});

test("mergeOverlappingCouncilTodos — merges shared expectedFiles", () => {
  const { merged, mergeCount } = mergeOverlappingCouncilTodos([
    { description: "Implement RF", expectedFiles: ["scripts/predict_tc.py"], createdBy: "a" },
    { description: "Add screen fn", expectedFiles: ["scripts/predict_tc.py"], createdBy: "b" },
    { description: "Expand JSON DB", expectedFiles: ["data/db.json"], createdBy: "a" },
  ]);
  assert.equal(mergeCount, 1);
  assert.equal(merged.length, 2);
  assert.match(merged[0]!.description, /Also \(b\)/);
});

test("sortCouncilTodosByTier — impl before test before build", () => {
  const sorted = sortCouncilTodosByTier([
    { description: "pytest", expectedFiles: [], createdBy: "x" },
    { description: "Implement module", expectedFiles: ["src/m.py"], createdBy: "x" },
    { description: "Add tests", expectedFiles: ["tests/t.py"], createdBy: "x" },
  ]);
  assert.equal(councilExecutionTier(sorted[0]!.description, sorted[0]!.expectedFiles), "impl");
  assert.equal(councilExecutionTier(sorted[1]!.description, sorted[1]!.expectedFiles), "test");
  assert.equal(councilExecutionTier(sorted[2]!.description, sorted[2]!.expectedFiles), "build");
});

test("prepareCouncilTodoBatch — merges then orders", () => {
  const logs: string[] = [];
  const out = prepareCouncilTodoBatch(
    [
      { description: "pytest", expectedFiles: [], createdBy: "x" },
      { description: "Wire predictor", expectedFiles: ["scripts/predict_tc.py"], createdBy: "x" },
      { description: "Extend predictor", expectedFiles: ["scripts/predict_tc.py"], createdBy: "y" },
    ],
    (m) => logs.push(m),
  );
  assert.equal(out.length, 2);
  assert.ok(logs.some((l) => l.includes("Merged 1 overlapping")));
  assert.ok(logs.some((l) => l.includes("build last")));
});

test("scoreCouncilTodoForDequeue — defers on file overlap with in-progress", () => {
  const score = scoreCouncilTodoForDequeue(
    { description: "Add tests", expectedFiles: ["scripts/predict_tc.py"], kind: "hunks" },
    [{ expectedFiles: ["scripts/predict_tc.py"] }],
    false,
  );
  assert.equal(score, Number.NEGATIVE_INFINITY);
});

test("scoreCouncilTodoForDequeue — defers build while hunks remain", () => {
  const score = scoreCouncilTodoForDequeue(
    { description: "pytest", expectedFiles: [], kind: "build" },
    [],
    true,
  );
  assert.equal(score, Number.NEGATIVE_INFINITY);
});

test("scoreCouncilTodoForDequeue — allows build when only build pending", () => {
  const score = scoreCouncilTodoForDequeue(
    { description: "pytest", expectedFiles: [], kind: "build" },
    [],
    false,
  );
  assert.ok(score > Number.NEGATIVE_INFINITY);
});

test("councilExecutionTier — Create Vitest is test tier not build (2964afe8)", () => {
  assert.equal(
    councilExecutionTier("Create Vitest unit tests for fao", [
      "server/__tests__/fao.test.js",
    ]),
    "test",
  );
});

test("prepareCouncilTodoBatch — caps ambition flood (2964afe8)", () => {
  const logs: string[] = [];
  const many = Array.from({ length: MAX_COUNCIL_TODOS_PER_BATCH + 5 }, (_, i) => ({
    description: `Implement feature ${i}`,
    expectedFiles: [`src/f${i}.ts`],
    createdBy: "x",
  }));
  const out = prepareCouncilTodoBatch(many, (m) => logs.push(m));
  assert.equal(out.length, MAX_COUNCIL_TODOS_PER_BATCH);
  assert.ok(logs.some((l) => /Capping/i.test(l)));
});
