import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCouncilTodo,
  buildCouncilTodoPost,
  looksLikeCodeSnippet,
  looksLikeShellCommand,
} from "./councilTodoClassify.js";

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

test("looksLikeCodeSnippet — python with / assignment", () => {
  assert.equal(looksLikeCodeSnippet("with placeholder.container():"), true);
  assert.equal(looksLikeCodeSnippet("avg_valence, avg_debye = features"), true);
  assert.equal(looksLikeCodeSnippet("npm run test"), false);
});

test("looksLikeShellCommand — real runners only", () => {
  assert.equal(looksLikeShellCommand("npm run test"), true);
  assert.equal(looksLikeShellCommand("pytest -q"), true);
  assert.equal(looksLikeShellCommand("with placeholder.container():"), false);
  assert.equal(looksLikeShellCommand("avg_valence, avg_debye = features"), false);
});

// Regression: run dd38a8df — edit todos with code-in-backticks were mis-routed
// to executeCouncilBuildTodo ("running build command: `with placeholder...`").
test("classifyCouncilTodo — streamlit indent fix is hunks not build", () => {
  const desc =
    "Fix streamlit_dashboard.py indentation: inside `with placeholder.container():`, " +
    "the `with tab1:` through `with tab8:` blocks must be nested under the container.";
  const r = classifyCouncilTodo(desc, ["streamlit_dashboard.py"]);
  assert.equal(r.kind, "hunks");
  assert.equal(r.command, undefined);
});

test("classifyCouncilTodo — predict_tc unpacking fix is hunks not build", () => {
  const desc =
    "Fix multiple bugs and clean up scripts/predict_tc.py: (1) Fix eliashberg_tc() " +
    "and mcmillan_tc() unpacking: `avg_valence, avg_debye = features` should unpack correctly.";
  const r = classifyCouncilTodo(desc, ["scripts/predict_tc.py"]);
  assert.equal(r.kind, "hunks");
  assert.equal(r.command, undefined);
});

test("classifyCouncilTodo — data file add remains hunks", () => {
  const r = classifyCouncilTodo(
    "Add LaSc2H24 entry to data/superconductor_database.json",
    ["data/superconductor_database.json"],
  );
  assert.equal(r.kind, "hunks");
});
