// R17 (2026-05-04): tests for the structured error taxonomy.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  aggregateByCategory,
  type ClassifiedError,
} from "./errorTaxonomy.js";

test("classifyError — causeHint wins over message patterns", () => {
  const got = classifyError({
    message: "rate limit exceeded",
    causeHint: "user-stop",
  });
  assert.equal(got.category, "user-stop");
  assert.equal(got.retryable, false);
});

test("classifyError — HTTP 401 → auth (not retryable)", () => {
  const got = classifyError({ message: "Unauthorized", statusCode: 401 });
  assert.equal(got.category, "auth");
  assert.equal(got.retryable, false);
});

test("classifyError — HTTP 403 → auth", () => {
  const got = classifyError({ message: "Forbidden", statusCode: 403 });
  assert.equal(got.category, "auth");
});

test("classifyError — HTTP 429 → quota (retryable)", () => {
  const got = classifyError({ message: "Too many requests", statusCode: 429 });
  assert.equal(got.category, "quota");
  assert.equal(got.retryable, true);
});

test("classifyError — HTTP 500 → network (retryable)", () => {
  const got = classifyError({ message: "Internal Server Error", statusCode: 500 });
  assert.equal(got.category, "network");
  assert.equal(got.retryable, true);
});

test("classifyError — HTTP 503 with quota in body → quota", () => {
  const got = classifyError({
    message: "Service unavailable: quota exceeded",
    statusCode: 503,
  });
  assert.equal(got.category, "quota");
});

test("classifyError — HTTP 503 without quota signal → network", () => {
  const got = classifyError({ message: "Service unavailable", statusCode: 503 });
  assert.equal(got.category, "network");
});

test("classifyError — message: rate-limit pattern → quota", () => {
  const got = classifyError({ message: "Hit rate-limit on Anthropic" });
  assert.equal(got.category, "quota");
});

test("classifyError — message: 429 in text → quota", () => {
  const got = classifyError({ message: "Provider returned 429" });
  assert.equal(got.category, "quota");
});

test("classifyError — message: invalid api key → auth", () => {
  const got = classifyError({ message: "invalid api key provided" });
  assert.equal(got.category, "auth");
});

test("classifyError — message: ECONNRESET → network", () => {
  const got = classifyError({ message: "fetch failed: ECONNRESET" });
  assert.equal(got.category, "network");
});

test("classifyError — message: ENOTFOUND → network", () => {
  const got = classifyError({ message: "ENOTFOUND api.anthropic.com" });
  assert.equal(got.category, "network");
});

test("classifyError — message: UND_ERR_HEADERS_TIMEOUT → timeout", () => {
  const got = classifyError({ message: "UND_ERR_HEADERS_TIMEOUT" });
  assert.equal(got.category, "timeout");
});

test("classifyError — message: operation was aborted → timeout", () => {
  const got = classifyError({ message: "The operation was aborted" });
  assert.equal(got.category, "timeout");
});

test("classifyError — message: ENOSPC → disk", () => {
  const got = classifyError({ message: "ENOSPC: no space left on device" });
  assert.equal(got.category, "disk");
});

test("classifyError — message: EACCES on git path → disk", () => {
  const got = classifyError({ message: "EACCES: permission denied, git clone" });
  assert.equal(got.category, "disk");
});

test("classifyError — message: out of memory → oom", () => {
  const got = classifyError({ message: "JavaScript heap out of memory" });
  assert.equal(got.category, "oom");
});

test("classifyError — message: cap reached → cap", () => {
  const got = classifyError({ message: "wall-clock cap reached" });
  assert.equal(got.category, "cap");
  assert.equal(got.retryable, false);
});

test("classifyError — message: empty response → model-output", () => {
  const got = classifyError({ message: "Empty response from model" });
  assert.equal(got.category, "model-output");
  assert.equal(got.retryable, true);
});

test("classifyError — message: malformed JSON → model-output", () => {
  const got = classifyError({ message: "malformed JSON in tool args" });
  assert.equal(got.category, "model-output");
});

test("classifyError — message: git fatal → git", () => {
  const got = classifyError({ message: "git fatal: refusing to merge" });
  assert.equal(got.category, "git");
  assert.equal(got.retryable, false);
});

test("classifyError — message: invariant → runner-bug", () => {
  const got = classifyError({ message: "invariant violated: state is null" });
  assert.equal(got.category, "runner-bug");
  assert.equal(got.retryable, false);
});

test("classifyError — message: stopped by user → user-stop", () => {
  const got = classifyError({ message: "Stopped by user request" });
  assert.equal(got.category, "user-stop");
});

test("classifyError — unmatched message → unknown", () => {
  const got = classifyError({ message: "weird thing happened" });
  assert.equal(got.category, "unknown");
  assert.equal(got.retryable, false);
});

test("classifyError — empty message → unknown", () => {
  const got = classifyError({ message: "" });
  assert.equal(got.category, "unknown");
});

test("classifyError — detail truncates very long raw messages", () => {
  const long = "x".repeat(500);
  const got = classifyError({ message: long });
  assert.ok(got.detail.includes("…"), "expected truncation marker");
  assert.ok(got.detail.length < 300, "expected detail to be capped");
});

test("classifyError — preserves rawMessage even when detail is truncated", () => {
  const long = "x".repeat(500);
  const got = classifyError({ message: long });
  assert.equal(got.rawMessage.length, 500);
});

test("aggregateByCategory — empty input → all zeros", () => {
  const got = aggregateByCategory([]);
  assert.equal(got.quota, 0);
  assert.equal(got.unknown, 0);
});

test("aggregateByCategory — counts each category", () => {
  const errors: ClassifiedError[] = [
    classifyError({ message: "x", statusCode: 429 }),
    classifyError({ message: "y", statusCode: 429 }),
    classifyError({ message: "z", statusCode: 500 }),
    classifyError({ message: "w" }),
  ];
  const got = aggregateByCategory(errors);
  assert.equal(got.quota, 2);
  assert.equal(got.network, 1);
  assert.equal(got.unknown, 1);
});
