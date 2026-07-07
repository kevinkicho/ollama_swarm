import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCouncilTodo, buildCouncilTodoPost } from "./councilTodoClassify.js";

test("classifyCouncilTodo — run script.py → python build", () => {
  const r = classifyCouncilTodo("Run predict_tc.py to generate outputs", []);
  assert.equal(r.kind, "build");
  assert.equal(r.command, "python predict_tc.py");
});

test("classifyCouncilTodo — pytest detection", () => {
  const r = classifyCouncilTodo("Run pytest on the test suite", []);
  assert.equal(r.kind, "build");
  assert.equal(r.command, "pytest");
});

test("classifyCouncilTodo — backtick command", () => {
  const r = classifyCouncilTodo("Execute `npm run test` and verify", []);
  assert.equal(r.kind, "build");
  assert.equal(r.command, "npm run test");
});

test("classifyCouncilTodo — default hunks for file edits", () => {
  const r = classifyCouncilTodo("Add error handling to server.ts", ["server.ts"]);
  assert.equal(r.kind, "hunks");
  assert.equal(r.command, undefined);
});

test("buildCouncilTodoPost — includes kind and command for build todos", () => {
  const post = buildCouncilTodoPost({
    description: "Run predict_tc.py",
    expectedFiles: ["output.json"],
    createdBy: "auditor",
    criterionId: "c1",
  });
  assert.equal(post.kind, "build");
  assert.equal(post.command, "python predict_tc.py");
  assert.equal(post.criterionId, "c1");
});