import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExitCriterion } from "./blackboard/types.js";
import {
  buildUnmetFailSignature,
  unmetFailsAreTransientOnly,
  fallbackMayMarkMet,
  isExecutableCriterion,
  ledgerFailCountForCriterion,
  reconcileCriteriaFromLedger,
} from "./councilLedgerReconcile.js";
import { createEmptyLedger, appendLedgerObservation } from "./councilProgressLedger.js";

const crit = (partial: Partial<ExitCriterion> & Pick<ExitCriterion, "id" | "description">): ExitCriterion => ({
  expectedFiles: [],
  status: "unmet",
  ...partial,
});

test("isExecutableCriterion detects code-shaped criteria", () => {
  assert.equal(
    isExecutableCriterion(crit({ id: "c1", description: "Update docs", expectedFiles: ["README.md"] })),
    false,
  );
  assert.equal(
    isExecutableCriterion(
      crit({
        id: "c2",
        description: "Implement predict_tc",
        expectedFiles: ["scripts/predict_tc.py"],
      }),
    ),
    true,
  );
});

test("fallbackMayMarkMet blocks executable criterion without ledger commit", () => {
  const ledger = createEmptyLedger("run-1");
  const c = crit({
    id: "c1",
    description: "Implement ML model",
    expectedFiles: ["scripts/predict_tc.py"],
  });
  const d = fallbackMayMarkMet(c, ledger, false);
  assert.equal(d.met, false);
  assert.match(d.reason, /executable criterion requires ledger commit/);
});

test("fallbackMayMarkMet blocks when ledger shows fails on same files", () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "fail",
    text: "JSON parse failed",
    cycle: 2,
    files: ["docs/foo.md"],
  });
  const c = crit({ id: "c1", description: "Update doc", expectedFiles: ["docs/foo.md"] });
  const d = fallbackMayMarkMet(c, ledger, false);
  assert.equal(d.met, false);
  assert.match(d.reason, /ledger fail/);
});

test("reconcileCriteriaFromLedger promotes doc criterion after commit observation", () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "commit",
    text: "updated discovery strategy",
    cycle: 2,
    files: ["discovery_strategy.md"],
  });
  const criteria = [
    crit({ id: "c1", description: "Update strategy", expectedFiles: ["discovery_strategy.md"] }),
  ];
  const { criteria: out, promotedIds } = reconcileCriteriaFromLedger(ledger, criteria, []);
  assert.deepEqual(promotedIds, ["c1"]);
  assert.equal(out[0].status, "met");
});

test("unmetFailsAreTransientOnly — true for quota stalls only", () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "fail",
    text: "all retries exhausted (last: Ollama HTTP 429: session usage limit)",
    cycle: 8,
    files: ["run_pipeline.py"],
  });
  const criteria = [
    crit({ id: "c1", description: "pipeline", expectedFiles: ["run_pipeline.py"] }),
  ];
  assert.equal(
    unmetFailsAreTransientOnly(ledger, new Set(["c1"]), criteria, 8),
    true,
  );
});

test("unmetFailsAreTransientOnly — false when real tool-loop stuck mixed in", () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "fail",
    text: "tool loop stuck: 3× repeated read",
    cycle: 2,
    files: ["tests/test_run_pipeline.py"],
  });
  const criteria = [
    crit({ id: "c1", description: "tests", expectedFiles: ["tests/test_run_pipeline.py"] }),
  ];
  assert.equal(
    unmetFailsAreTransientOnly(ledger, new Set(["c1"]), criteria, 2),
    false,
  );
});

test("buildUnmetFailSignature is stable for same failures", () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "fail",
    text: "JSON parse failed: array",
    cycle: 3,
    files: ["scripts/predict_tc.py"],
  });
  const criteria = [
    crit({ id: "c1", description: "ML", expectedFiles: ["scripts/predict_tc.py"] }),
  ];
  const sig1 = buildUnmetFailSignature(ledger, new Set(["c1"]), criteria, 3);
  const sig2 = buildUnmetFailSignature(ledger, new Set(["c1"]), criteria, 4);
  assert.equal(sig1, sig2);
  assert.ok(sig1.length > 0);
});

test("ledgerFailCountForCriterion counts overlapping fails", () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "fail",
    text: "parse error",
    cycle: 1,
    files: ["data/superconductor_database.json"],
  });
  const c = crit({
    id: "c1",
    description: "Populate database",
    expectedFiles: ["data/superconductor_database.json"],
  });
  assert.equal(ledgerFailCountForCriterion(ledger, c), 1);
});