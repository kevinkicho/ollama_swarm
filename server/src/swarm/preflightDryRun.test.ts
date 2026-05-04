// Q10 (2026-05-04): tests for pre-flight verify dry-run helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideDryRunOutcome,
  buildDryRunFailurePromptAddendum,
} from "./preflightDryRun.js";

test("decideDryRunOutcome — verify ok → commit", () => {
  const got = decideDryRunOutcome({
    result: { ok: true, exitCode: 0, stderr: "" },
    retriesSoFar: 0,
  });
  assert.equal(got, "commit");
});

test("decideDryRunOutcome — verify fail + retries available → replan", () => {
  const got = decideDryRunOutcome({
    result: { ok: false, exitCode: 1, stderr: "test failed" },
    retriesSoFar: 0,
    maxRetries: 2,
  });
  assert.equal(got, "replan");
});

test("decideDryRunOutcome — verify fail + retries exhausted → skip", () => {
  const got = decideDryRunOutcome({
    result: { ok: false, exitCode: 1, stderr: "test failed" },
    retriesSoFar: 2,
    maxRetries: 2,
  });
  assert.equal(got, "skip");
});

test("decideDryRunOutcome — uses default max=2 when not supplied", () => {
  // 1 retry done, 1 remaining → replan
  assert.equal(
    decideDryRunOutcome({
      result: { ok: false, exitCode: 1, stderr: "" },
      retriesSoFar: 1,
    }),
    "replan",
  );
  // 2 retries done → skip
  assert.equal(
    decideDryRunOutcome({
      result: { ok: false, exitCode: 1, stderr: "" },
      retriesSoFar: 2,
    }),
    "skip",
  );
});

test("buildDryRunFailurePromptAddendum — includes exit code + stderr", () => {
  const addendum = buildDryRunFailurePromptAddendum({
    exitCode: 1,
    stderr: "Test 'foo bar' failed: expected 5 got 3",
    retriesSoFar: 0,
  });
  assert.match(addendum, /exited with code 1/);
  assert.match(addendum, /Test 'foo bar' failed/);
  assert.match(addendum, /Pre-flight verify FAILED/);
});

test("buildDryRunFailurePromptAddendum — shows remaining retries", () => {
  const addendum = buildDryRunFailurePromptAddendum({
    exitCode: 1,
    stderr: "x",
    retriesSoFar: 0,
    maxRetries: 3,
  });
  assert.match(addendum, /Retries remaining for this todo: 3/);
  // After 1 failed retry
  const addendum2 = buildDryRunFailurePromptAddendum({
    exitCode: 1,
    stderr: "x",
    retriesSoFar: 1,
    maxRetries: 3,
  });
  assert.match(addendum2, /Retries remaining for this todo: 2/);
});

test("buildDryRunFailurePromptAddendum — truncates very long stderr", () => {
  const longStderr = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const addendum = buildDryRunFailurePromptAddendum({
    exitCode: 1,
    stderr: longStderr,
    retriesSoFar: 0,
  });
  assert.match(addendum, /more lines truncated/);
  // First 30 lines should appear; later lines should not
  assert.match(addendum, /line 5/);
  assert.equal(addendum.includes("line 50"), false);
});

test("buildDryRunFailurePromptAddendum — handles empty stderr gracefully", () => {
  const addendum = buildDryRunFailurePromptAddendum({
    exitCode: 1,
    stderr: "",
    retriesSoFar: 0,
  });
  assert.match(addendum, /no stderr captured/);
});

test("buildDryRunFailurePromptAddendum — instructs `skip` envelope for out-of-scope failures", () => {
  const addendum = buildDryRunFailurePromptAddendum({
    exitCode: 1,
    stderr: "test from another module",
    retriesSoFar: 0,
  });
  assert.match(addendum, /pre-flight-verify-out-of-scope/);
});
