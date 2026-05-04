// R15 (2026-05-04): tests for auto-RCA generator.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRca } from "./autoRca.js";
import { classifyError } from "./errorTaxonomy.js";

test("generateRca — clean success → needsAttention=false, empty markdown", () => {
  const got = generateRca({
    finalPhase: "completed",
    terminationReason: null,
    errors: [],
    commitsLanded: 3,
    tier: 2,
    durationMs: 600_000,
  });
  assert.equal(got.needsAttention, false);
  assert.equal(got.markdown, "");
});

test("generateRca — quota wall → recommends failover chain", () => {
  const errors = [
    classifyError({ message: "rate limit", statusCode: 429 }),
    classifyError({ message: "429", statusCode: 429 }),
    classifyError({ message: "rate limit", statusCode: 429 }),
  ];
  const got = generateRca({
    finalPhase: "paused",
    terminationReason: "quota wall",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 300_000,
  });
  assert.equal(got.needsAttention, true);
  assert.match(got.primaryCause, /quota/i);
  assert.match(got.recommendation, /failover/i);
  assert.match(got.markdown, /Auto-RCA/);
});

test("generateRca — auth failure → recommends checking API keys", () => {
  const errors = [
    classifyError({ message: "Unauthorized", statusCode: 401 }),
  ];
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: "auth",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 5000,
  });
  assert.match(got.recommendation, /API key/i);
});

test("generateRca — network failures → recommends re-run", () => {
  const errors = [
    classifyError({ message: "ECONNRESET" }),
    classifyError({ message: "ECONNRESET" }),
  ];
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: "network",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 60_000,
  });
  assert.match(got.recommendation, /transient|status page/i);
});

test("generateRca — model-output → recommends stronger model / json repair", () => {
  const errors = [
    classifyError({ message: "empty response" }),
    classifyError({ message: "malformed JSON" }),
  ];
  const got = generateRca({
    finalPhase: "completed",
    terminationReason: null,
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 600_000,
  });
  assert.match(got.recommendation, /stronger model|JsonRepair/i);
});

test("generateRca — disk → recommends freeing disk space", () => {
  const errors = [classifyError({ message: "ENOSPC" })];
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: "disk",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 10_000,
  });
  assert.match(got.recommendation, /disk space/i);
});

test("generateRca — oom → recommends raising heap size", () => {
  const errors = [classifyError({ message: "JavaScript heap out of memory" })];
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: "oom",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 100_000,
  });
  assert.match(got.recommendation, /max-old-space-size/);
});

test("generateRca — runner-bug → recommends filing a bug", () => {
  const errors = [classifyError({ message: "invariant violated" })];
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: "runner-bug",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 30_000,
  });
  assert.match(got.recommendation, /bug/i);
});

test("generateRca — cap reached → recommends raising cap or shortening directive", () => {
  const errors = [classifyError({ message: "wall-clock cap reached" })];
  const got = generateRca({
    finalPhase: "stopped",
    terminationReason: "cap",
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 30 * 60_000,
  });
  assert.match(got.recommendation, /cap|directive/i);
});

test("generateRca — fast death without errors → 'startup failure'", () => {
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: null,
    errors: [],
    commitsLanded: 0,
    tier: 0,
    durationMs: 5000,
  });
  assert.match(got.primaryCause, /startup failure/);
});

test("generateRca — long run, 0 commits, 0 tier, no errors → 'finished without artifacts'", () => {
  const got = generateRca({
    finalPhase: "completed",
    terminationReason: null,
    errors: [],
    commitsLanded: 0,
    tier: 0,
    durationMs: 5 * 60_000,
  });
  assert.equal(got.needsAttention, true);
  assert.match(got.recommendation, /artifacts|smaller|concrete/i);
});

test("generateRca — markdown includes secondary causes when present", () => {
  const errors = [
    classifyError({ message: "rate limit", statusCode: 429 }),
    classifyError({ message: "rate limit", statusCode: 429 }),
    classifyError({ message: "ECONNRESET" }),
  ];
  const got = generateRca({
    finalPhase: "paused",
    terminationReason: null,
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 60_000,
  });
  assert.match(got.markdown, /quota/i);
  assert.match(got.markdown, /Other contributors/);
});

test("generateRca — markdown includes per-category counts", () => {
  const errors = [
    classifyError({ message: "rate limit", statusCode: 429 }),
    classifyError({ message: "ECONNRESET" }),
  ];
  const got = generateRca({
    finalPhase: "failed",
    terminationReason: null,
    errors,
    commitsLanded: 0,
    tier: 0,
    durationMs: 60_000,
  });
  assert.match(got.markdown, /Error counts by category/);
  assert.match(got.markdown, /quota: 1/);
  assert.match(got.markdown, /network: 1/);
});

test("generateRca — needsAttention=true when no commits even on 'completed' phase", () => {
  const got = generateRca({
    finalPhase: "completed",
    terminationReason: null,
    errors: [],
    commitsLanded: 0,
    tier: 0,
    durationMs: 60_000,
  });
  assert.equal(got.needsAttention, true);
});
