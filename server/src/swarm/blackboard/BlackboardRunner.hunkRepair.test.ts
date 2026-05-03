// 2026-05-02: structural regression tests for the hunk-repair retry
// path added to BlackboardRunner.executeWorkerTodo. Mocking the full
// worker pipeline (Agent + AgentManager + applyHunks + git) to test
// behavior in isolation costs ~300 LOC of test scaffolding for one new
// branch. Source-grep checks lock the wiring with much less overhead
// AND make the regression failure obvious if a future refactor breaks
// the contract.
//
// Why this matters: pre-fix, every applyHunks failure (search-not-found,
// search-not-unique, create-on-existing) escalated straight to replan
// — forcing the planner to re-emit a new TODO. The retry path lets the
// worker fix its OWN hunks against the actual file content, which is
// the right level for anchor-mismatch errors and ~5x faster than a
// full planner re-pass. Targets ~30% of the pre-fix verify=FAIL cases
// from Sweep 1B blackboard data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = readFileSync(join(__dirname, "BlackboardRunner.ts"), "utf8");

test("BlackboardRunner — buildHunkRepairPrompt is actually called (was dead import pre-fix)", () => {
  // Pre-fix: buildHunkRepairPrompt was imported but never called. The
  // import was a documented future-work placeholder. The fix wires it
  // into the executeWorkerTodo retry path.
  assert.match(
    RUNNER_SRC,
    /buildHunkRepairPrompt\(\s*hunksToCommit/,
    "buildHunkRepairPrompt must be called with the failed hunks as the first arg",
  );
});

test("BlackboardRunner — retry only fires on recoverable apply failures (failedHunkIndex set)", () => {
  // Recoverable = applyHunks rejected the hunk's anchor (search-not-
  // unique, search-not-found, create-on-existing). Non-recoverable =
  // read/write/git/verify failures (re-prompting the worker can't fix
  // those). The fix gates the retry on failedHunkIndex !== undefined,
  // which applyAndCommit only sets for apply-time errors.
  assert.match(
    RUNNER_SRC,
    /!applyResult\.ok\s*&&[\s\S]{0,80}failedHunkIndex !== undefined/,
    "retry must be gated on failedHunkIndex (only fires for apply-time errors)",
  );
});

test("BlackboardRunner — retry re-reads files before repair prompt (catches partial-write races)", () => {
  // applyAndCommit is atomic per-file but multi-hunk batches can write
  // earlier hunks before failing on a later one. Re-reading via
  // readExpectedFiles after a partial-failure ensures the repair
  // prompt sees what's actually on disk, not what was on disk pre-batch.
  assert.match(
    RUNNER_SRC,
    /hunk-repair[\s\S]{0,500}readExpectedFiles\(todo\.expectedFiles\)/,
    "retry must re-read files before building the repair prompt",
  );
});

test("BlackboardRunner — retry uses WORKER_HUNKS_JSON_SCHEMA for constrained decoding", () => {
  // Same constrained-decoding schema as the initial worker call (#96).
  // Without this, Ollama would emit free-form JSON that frequently
  // breaks parseWorkerResponse — defeating the whole point of giving
  // the model a second chance.
  assert.match(
    RUNNER_SRC,
    /hunk-repair[\s\S]{0,800}WORKER_HUNKS_JSON_SCHEMA/,
    "retry must pass WORKER_HUNKS_JSON_SCHEMA so Ollama constrains its output",
  );
});

test("BlackboardRunner — retry falls through to replan on second failure", () => {
  // After the retry, applyResult is reassigned. The original failTodoQ
  // path still runs if the new applyResult is still !ok. This is the
  // safety net — replan is the right escalation when the worker can't
  // fix its own hunks even with the file content in hand.
  // Verify by counting failTodoQ calls in the executeWorkerTodo region:
  // there should still be a "[v2] applyAndCommit failed" failTodoQ
  // AFTER the retry block.
  const executeRegion = RUNNER_SRC.match(/private async executeWorkerTodo[\s\S]*?private async/);
  assert.ok(executeRegion, "executeWorkerTodo region must exist");
  const failCalls = (executeRegion[0].match(/applyAndCommit failed/g) ?? []).length;
  assert.ok(
    failCalls >= 2,
    `must have at least 2 "applyAndCommit failed" failTodoQ sites (one in retry-path fallthrough, one in original) — found ${failCalls}`,
  );
});

test("BlackboardRunner — retry is gated on !this.stopping (don't spend a turn after user stop)", () => {
  // If the user pressed Stop while the first apply was running, don't
  // burn a second worker prompt before honoring the stop signal.
  assert.match(
    RUNNER_SRC,
    /failedHunkIndex !== undefined[\s\S]{0,60}!this\.stopping/,
    "retry block must check this.stopping before re-prompting",
  );
});
