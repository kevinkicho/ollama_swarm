// R1 (2026-05-04): tests for provider-failover decision helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFailover } from "./providerFailover.js";
import { classifyError } from "./errorTaxonomy.js";

test("decideFailover — quota with available fallback → swap", () => {
  const got = decideFailover({
    currentModel: "claude-opus-4-7",
    classified: classifyError({ message: "rate limit", statusCode: 429 }),
    failoverChain: ["claude-haiku-4-5", "glm-5.1:cloud"],
    alreadyTried: new Set(["claude-opus-4-7"]),
  });
  assert.equal(got.action, "swap");
  assert.equal(got.nextModel, "claude-haiku-4-5");
});

test("decideFailover — quota with chain exhausted → give-up", () => {
  const got = decideFailover({
    currentModel: "claude-opus-4-7",
    classified: classifyError({ message: "rate limit", statusCode: 429 }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(["claude-opus-4-7", "claude-haiku-4-5"]),
  });
  assert.equal(got.action, "give-up");
});

test("decideFailover — auth with available fallback → swap", () => {
  const got = decideFailover({
    currentModel: "claude-opus-4-7",
    classified: classifyError({ message: "Unauthorized", statusCode: 401 }),
    failoverChain: ["glm-5.1:cloud"],
    alreadyTried: new Set(["claude-opus-4-7"]),
  });
  assert.equal(got.action, "swap");
  assert.equal(got.nextModel, "glm-5.1:cloud");
});

test("decideFailover — network → retry-same (transient)", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "ECONNRESET" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(["glm-5.1:cloud"]),
  });
  assert.equal(got.action, "retry-same");
});

test("decideFailover — timeout → retry-same", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "operation was aborted" }),
    failoverChain: [],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "retry-same");
});

test("decideFailover — model-output with chain → swap (961a885f format failover)", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "empty response" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(["glm-5.1:cloud"]),
  });
  assert.equal(got.action, "swap");
  assert.equal(got.nextModel, "claude-haiku-4-5");
});

test("decideFailover — model-output empty chain → give-up (no invent)", () => {
  const got = decideFailover({
    currentModel: "deepseek-v4-flash:cloud",
    classified: classifyError({
      message: "json format sniff: think-only stream 16,008 chars with no JSON markers",
    }),
    failoverChain: [],
    alreadyTried: new Set(["deepseek-v4-flash:cloud"]),
  });
  assert.equal(got.action, "give-up");
  assert.match(got.reason ?? "", /no failover model/i);
});

test("decideFailover — cap → give-up (terminal)", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "wall-clock cap reached" }),
    failoverChain: ["claude-haiku-4-5"], // chain available but ignored
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "give-up");
});

test("decideFailover — user-stop → give-up", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "x", causeHint: "user-stop" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "give-up");
});

test("decideFailover — runner-bug → give-up (don't mask bugs)", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "invariant violated" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "give-up");
});

test("decideFailover — disk failure → give-up (local issue)", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "ENOSPC" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "give-up");
});

test("decideFailover — oom → give-up", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "JavaScript heap out of memory" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "give-up");
});

test("decideFailover — git non-retryable with chain → swap", () => {
  // Edge case: caller might still want to try a different model on a
  // git-classified failure (git error from the *model's* tool call,
  // not from our orchestrator git ops).
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "git fatal: refusing" }),
    failoverChain: ["claude-haiku-4-5"],
    alreadyTried: new Set(["glm-5.1:cloud"]),
  });
  assert.equal(got.action, "swap");
  assert.equal(got.nextModel, "claude-haiku-4-5");
});

test("decideFailover — chain skips currentModel even if not in alreadyTried", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "rate limit", statusCode: 429 }),
    failoverChain: ["glm-5.1:cloud", "claude-haiku-4-5"],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "swap");
  assert.equal(got.nextModel, "claude-haiku-4-5");
});

test("decideFailover — empty chain on quota → give-up", () => {
  const got = decideFailover({
    currentModel: "glm-5.1:cloud",
    classified: classifyError({ message: "rate limit", statusCode: 429 }),
    failoverChain: [],
    alreadyTried: new Set(),
  });
  assert.equal(got.action, "give-up");
});
