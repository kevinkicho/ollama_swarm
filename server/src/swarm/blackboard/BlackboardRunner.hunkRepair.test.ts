// 2026-05-02: structural regression tests for the hunk-repair retry
// path. The logic now lives in workerRunner.ts (refactored from
// BlackboardRunner.ts). Source-grep checks lock the wiring with much
// less overhead than mocking the full worker pipeline.
//
// Why this matters: pre-fix, every applyHunks failure escalated straight
// to replan. The retry path lets the worker fix its OWN hunks against the
// actual file content, which is ~5x faster than a full planner re-pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = readFileSync(join(__dirname, "workerRunner.ts"), "utf8");

test("workerRunner — buildHunkRepairPrompt is actually called in executeWorkerTodo", () => {
  assert.match(
    WORKER_SRC,
    /buildHunkRepairPrompt\(/,
    "buildHunkRepairPrompt must be called in the worker runner",
  );
});

test("workerRunner — retry only fires on recoverable apply failures (failedHunkIndex set)", () => {
  assert.match(
    WORKER_SRC,
    /failedHunkIndex !== undefined/,
    "retry must be gated on failedHunkIndex (only fires for apply-time errors)",
  );
  assert.match(
    WORKER_SRC,
    /!ctx\.isStopping\(\)/,
    "retry must also check !ctx.isStopping()",
  );
});

test("workerRunner — retry re-reads files before repair prompt (catches partial-write races)", () => {
  assert.match(
    WORKER_SRC,
    /readExpectedFiles\(todo\.expectedFiles\)/,
    "retry must re-read files before building the repair prompt",
  );
});

test("workerRunner — retry uses WORKER_HUNKS_JSON_SCHEMA for constrained decoding", () => {
  assert.match(
    WORKER_SRC,
    /WORKER_HUNKS_JSON_SCHEMA/,
    "retry must pass WORKER_HUNKS_JSON_SCHEMA so Ollama constrains its output",
  );
});

test("workerRunner — retry falls through to replan on second failure", () => {
  // executeWorkerTodo is the last function in the file (ends at line 763)
  const executeRegion = WORKER_SRC.match(/export async function executeWorkerTodo[\s\S]*/);
  assert.ok(executeRegion, "executeWorkerTodo region must exist");
  // Count "hunk-repair" references — at least 2 (retry attempt + fallthrough log)
  const repairRefs = (executeRegion[0].match(/hunk-repair/g) ?? []).length;
  assert.ok(
    repairRefs >= 2,
    `must have at least 2 hunk-repair references (retry attempt + fallthrough) — found ${repairRefs}`,
  );
});

test("workerRunner — retry is gated on !ctx.isStopping() (don't spend a turn after user stop)", () => {
  assert.match(
    WORKER_SRC,
    /failedHunkIndex !== undefined[\s\S]{0,80}!ctx\.isStopping\(\)/,
    "retry block must check ctx.isStopping() before re-prompting",
  );
});
