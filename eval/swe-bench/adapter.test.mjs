import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptSweBenchTask, adaptSweBenchJsonl } from "./adapter.mjs";

const SAMPLE_TASK = {
  instance_id: "astropy__astropy-12907",
  repo: "astropy/astropy",
  base_commit: "deadbeefcafe1234567890",
  problem_statement: "Modeling's separability_matrix does not compute separability correctly for nested CompoundModels.",
  patch: "diff --git a/foo b/foo\n...",
  test_patch: "diff --git a/foo_test b/foo_test\n...",
  hints_text: "I think the issue is in _separable",
};

const NODE_FRIENDLY_TASK = {
  instance_id: "express__express-1234",
  repo: "expressjs/express",
  base_commit: "abc123",
  problem_statement: "router.use() drops the trailing slash",
  patch: "diff ...",
  test_patch: "diff ...",
};

test("adaptSweBenchTask — happy path produces catalog-shaped entry", () => {
  const entry = adaptSweBenchTask(NODE_FRIENDLY_TASK);
  assert.equal(entry.id, "swe-bench:express__express-1234");
  assert.equal(entry.title, "express #1234");
  assert.equal(entry.repo, "expressjs/express");
  assert.equal(entry.baseCommit, "abc123");
  assert.equal(entry.expectFilesChanged, true);
  assert.deepEqual(entry.presets, ["blackboard"]);
  assert.equal(typeof entry.directive, "string");
  assert.match(entry.directive, /SWE-Bench task: express__express-1234/);
  assert.match(entry.directive, /router\.use\(\) drops the trailing slash/);
  // Node-friendly repo not in the env-incompatible list → no skipReason
  assert.equal(entry.skipReason, undefined);
});

test("adaptSweBenchTask — Python repo flagged env-incompatible", () => {
  const entry = adaptSweBenchTask(SAMPLE_TASK);
  assert.equal(entry.repo, "astropy/astropy");
  assert.match(entry.skipReason ?? "", /env-incompatible/);
  assert.match(entry.skipReason ?? "", /astropy\/astropy/);
  assert.match(entry.skipReason ?? "", /Docker/);
});

test("adaptSweBenchTask — directive includes hints when present", () => {
  const entry = adaptSweBenchTask(SAMPLE_TASK);
  assert.match(entry.directive, /=== Hints \(from issue comments\) ===/);
  assert.match(entry.directive, /I think the issue is in _separable/);
});

test("adaptSweBenchTask — directive omits hints section when absent", () => {
  const entry = adaptSweBenchTask(NODE_FRIENDLY_TASK);
  assert.doesNotMatch(entry.directive, /=== Hints/);
});

test("adaptSweBenchTask — directive truncated to 3900 chars", () => {
  const longTask = {
    ...NODE_FRIENDLY_TASK,
    problem_statement: "X".repeat(10000),
  };
  const entry = adaptSweBenchTask(longTask);
  assert.ok(entry.directive.length <= 3900 + "\n[...truncated]".length, `directive too long: ${entry.directive.length}`);
  assert.match(entry.directive, /\[\.\.\.truncated\]$/);
});

test("adaptSweBenchTask — overrides win over defaults", () => {
  const entry = adaptSweBenchTask(NODE_FRIENDLY_TASK, {
    presets: ["baseline", "blackboard"],
    rounds: 10,
    agentCount: 6,
    wallClockCapMs: 60_000,
  });
  assert.deepEqual(entry.presets, ["baseline", "blackboard"]);
  assert.equal(entry.rounds, 10);
  assert.equal(entry.agentCount, 6);
  assert.equal(entry.wallClockCapMs, 60_000);
});

test("adaptSweBenchTask — missing required field throws", () => {
  assert.throws(() => adaptSweBenchTask({ ...NODE_FRIENDLY_TASK, instance_id: "" }), /missing required field 'instance_id'/);
  assert.throws(() => adaptSweBenchTask({ ...NODE_FRIENDLY_TASK, repo: undefined }), /missing required field 'repo'/);
  assert.throws(() => adaptSweBenchTask(null), /must be a SweBenchTask object/);
});

test("adaptSweBenchJsonl — parses multi-line stream + collects errors", () => {
  const jsonl = [
    JSON.stringify(NODE_FRIENDLY_TASK),
    "{not valid json",
    JSON.stringify({ ...NODE_FRIENDLY_TASK, instance_id: "express__express-99" }),
    "", // blank line ignored
    JSON.stringify({ instance_id: "broken", repo: "x/y" }), // missing problem_statement
  ].join("\n");
  const result = adaptSweBenchJsonl(jsonl);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].id, "swe-bench:express__express-1234");
  assert.equal(result.entries[1].id, "swe-bench:express__express-99");
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].reason, /JSON parse failed/);
  assert.match(result.errors[1].reason, /base_commit/);
});

test("adaptSweBenchJsonl — limit option caps entry count", () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    ...NODE_FRIENDLY_TASK,
    instance_id: `express__express-${i}`,
  }));
  const jsonl = tasks.map((t) => JSON.stringify(t)).join("\n");
  const result = adaptSweBenchJsonl(jsonl, { limit: 3 });
  assert.equal(result.entries.length, 3);
});
