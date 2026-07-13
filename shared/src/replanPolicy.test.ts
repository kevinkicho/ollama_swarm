import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStaleReason,
  resolveReplanPolicy,
  shouldTriggerBatchReplanBreaker,
} from "./replanPolicy.js";

describe("classifyStaleReason", () => {
  it("classifies worker timeout and tool cap", () => {
    assert.equal(
      classifyStaleReason("[v2] worker prompt failed: prompt wall-clock exceeded 120000ms"),
      "worker-timeout",
    );
    assert.equal(
      classifyStaleReason("Ollama tool loop exceeded 35 turns"),
      "worker-tool-cap",
    );
  });

  it("classifies CAS and hunk failures", () => {
    assert.equal(classifyStaleReason("CAS mismatch on t2"), "cas-drift");
    assert.equal(classifyStaleReason("hunk apply failed: search not unique"), "hunk-fail");
  });

  it("classifies no-op / zero-write as hunk-fail", () => {
    assert.equal(
      classifyStaleReason("apply produced no file changes (no-op elided)"),
      "hunk-fail",
    );
    assert.equal(
      classifyStaleReason("apply wrote zero files (no-op) — not a successful commit"),
      "hunk-fail",
    );
  });
});

describe("resolveReplanPolicy", () => {
  it("emit-first for worker timeout", () => {
    const p = resolveReplanPolicy("prompt wall-clock exceeded 120000ms");
    assert.equal(p.emitFirst, true);
    assert.equal(p.maxToolTurns, 8);
  });

  it("zero tools when batch breaker or cache", () => {
    const p = resolveReplanPolicy("prompt wall-clock exceeded", { batchBreaker: true });
    assert.equal(p.maxToolTurns, 0);
    assert.equal(p.emitFirst, true);
  });
});

describe("shouldTriggerBatchReplanBreaker", () => {
  it("triggers at 3 correlated worker timeouts", () => {
    const todos = [
      { status: "stale", staleReason: "wall-clock exceeded" },
      { status: "stale", staleReason: "wall-clock exceeded" },
      { status: "stale", staleReason: "wall-clock exceeded" },
    ];
    assert.equal(shouldTriggerBatchReplanBreaker(todos), true);
  });
});