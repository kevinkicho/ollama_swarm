/**
 * Thrash-fix invariants (120b2044 / eee6718f / 2010479c) — pure unit locks.
 *
 * Does not spin LLMs. Locks the settlement/classify/recovery rules that
 * prevent nested same-model re-emit thrash, garbage-skip thrash, and
 * false terminal metrics when det/LLM recovery lands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCycleFailReason } from "./cycleIntegrityReport.js";
import { classifyWorkerSkip, isGarbageSkipReason } from "./skipClassify.js";
import {
  createApplyIntegrityCounters,
  recordMissRecoveredDet,
  recordMissRecoveredLlm,
  recordMissTerminal,
  recordRepairFailure,
  recordRepairSuccess,
  snapshotApplyIntegrity,
} from "./applyIntegrityReport.js";

describe("thrash invariants — apply_miss class (skip same-model re-emit)", () => {
  it("classifies search-not-found / not unique as apply_miss", () => {
    assert.equal(classifyCycleFailReason("search text not found"), "apply_miss");
    assert.equal(classifyCycleFailReason("hunk-fail: search not found"), "apply_miss");
    assert.equal(classifyCycleFailReason("search not unique"), "apply_miss");
    assert.equal(classifyCycleFailReason("start not unique in App.tsx"), "apply_miss");
    assert.equal(
      classifyCycleFailReason("endExclusive text not found after start"),
      "apply_miss",
    );
  });

  it("classifies JSON/envelope failures as json_parse or no_hunks (stage-2 repair still OK)", () => {
    const jsonish = classifyCycleFailReason("JSON parse failed: Unexpected token");
    assert.ok(
      jsonish === "json_parse" || jsonish === "schema" || jsonish === "other",
      `json fail bucket was ${jsonish}`,
    );
    assert.equal(classifyCycleFailReason("worker returned no hunks"), "no_hunks");
    assert.equal(
      classifyCycleFailReason("worker returned no hunks (garbage skip placeholder)"),
      "no_hunks",
    );
  });

  it("build_misroute is distinct from apply_miss (no re-emit thrash path)", () => {
    assert.equal(
      classifyCycleFailReason("build_misroute: bare `vitest` produced no file changes"),
      "build_misroute",
    );
  });
});

describe("thrash invariants — garbage skip → no_hunks retry (not permanent settle)", () => {
  it("rejects placeholder skip reasons", () => {
    for (const raw of ["reason", "none", "n/a", "skip", "todo", "", "  ", "null"]) {
      assert.equal(isGarbageSkipReason(raw), true, `expected garbage: ${JSON.stringify(raw)}`);
      const c = classifyWorkerSkip(raw);
      assert.equal(c.ok, false);
      if (!c.ok) assert.equal(c.reason, "garbage_skip");
    }
  });

  it("accepts real already-done / out-of-scope skips", () => {
    const done = classifyWorkerSkip("already done — file already has null guard");
    assert.equal(done.ok, true);
    if (done.ok) {
      assert.equal(done.code, "already_done");
      assert.equal(done.permanent, true);
    }
    const scope = classifyWorkerSkip("out of scope for this run");
    assert.equal(scope.ok, true);
    if (scope.ok) assert.equal(scope.code, "out_of_scope");
  });
});

describe("thrash invariants — recovered miss is not terminal fail metric", () => {
  it("det recovery increments missRecoveredDet without missTerminal", () => {
    const c = createApplyIntegrityCounters();
    recordRepairSuccess(c);
    recordMissRecoveredDet(c);
    const snap = snapshotApplyIntegrity(c)!;
    assert.equal(snap.missRecoveredDet, 1);
    assert.equal(snap.missTerminal, undefined);
    assert.equal(snap.repairSuccesses, 1);
  });

  it("llm recovery increments missRecoveredLlm", () => {
    const c = createApplyIntegrityCounters();
    recordRepairSuccess(c);
    recordMissRecoveredLlm(c);
    const snap = snapshotApplyIntegrity(c)!;
    assert.equal(snap.missRecoveredLlm, 1);
    assert.equal(snap.missTerminal, undefined);
  });

  it("failed grounded repair is terminal", () => {
    const c = createApplyIntegrityCounters();
    recordRepairFailure(c);
    recordMissTerminal(c);
    const snap = snapshotApplyIntegrity(c)!;
    assert.equal(snap.missTerminal, 1);
    assert.equal(snap.repairFailures, 1);
    assert.equal(snap.missRecoveredDet, undefined);
  });
});

describe("thrash invariants — stage-2 policy source (stack tests via source modules)", () => {
  it("documents that apply_miss must not trigger same-model full re-emit", () => {
    // Behavioral lock: when primaryBucket === apply_miss, retry chain skips
    // tryWorkerPrompt with repairFrom and only allows failover model.
    // Enforced in councilWorkerRetryChain.ts (stack tests in councilWorkerRunner.test.ts).
    const bucket = classifyCycleFailReason("search text not found in file");
    assert.equal(bucket, "apply_miss");
    // Format failures remain eligible for envelope repair:
    const format = classifyCycleFailReason("worker returned no hunks");
    assert.notEqual(format, "apply_miss");
  });
});
