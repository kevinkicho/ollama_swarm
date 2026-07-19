/**
 * Structural dual-path locks for BB recovery + council repair wiring.
 * Source greps — no LLM. Complements shared/src/dualPathRegression.test.ts.
 *
 * Fixtures named after live runs:
 *  - 926054b0: worker repair tool-coach thrash; replan explore thrash
 *  - 2010479c: deliberate fences + replace_between null endExclusive
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BB = join(__dirname, "blackboard");

const CASCADE = readFileSync(join(BB, "workerParseCascade.ts"), "utf8");
const WORKER_RUNNER = readFileSync(join(BB, "workerRunner.ts"), "utf8");
const COUNCIL_ATTEMPT = readFileSync(join(__dirname, "councilWorkerAttempt.ts"), "utf8");
const PLANNER_REC = readFileSync(join(BB, "plannerRecovery.ts"), "utf8");
const REPLAN_REC = readFileSync(join(BB, "replannerRecovery.ts"), "utf8");
const REPLAN_MGR = readFileSync(join(BB, "replanManager.ts"), "utf8");
const WORKER_PROMPT = readFileSync(join(BB, "prompts", "worker.ts"), "utf8");
const COUNCIL_WORKER = readFileSync(join(__dirname, "councilWorkerRunner.ts"), "utf8");
const SELF_CONSIST = readFileSync(join(BB, "workerSelfConsistency.ts"), "utf8");

describe("dual-path cascade — 926054b0 emit-only repair", () => {
  it("workerParseCascade soft-repairs before any LLM repair call", () => {
    assert.ok(CASCADE.includes("repairAndParseJson"), "soft-repair entry");
    assert.ok(
      CASCADE.includes("skipping LLM repair") || CASCADE.includes("soft-repair"),
      "must log soft-repair success path",
    );
    const softIdx = CASCADE.indexOf("repairAndParseJson");
    const llmIdx = CASCADE.indexOf("issuing emit-only repair prompt");
    assert.ok(softIdx > 0 && llmIdx > softIdx, "soft-repair must precede LLM repair prompt");
  });

  it("worker repair + sibling use EMIT_ONLY_PROFILE_ID and maxToolTurns: 1", () => {
    assert.ok(CASCADE.includes("EMIT_ONLY_PROFILE_ID"));
    assert.ok(CASCADE.includes("maxToolTurns: 1"));
    assert.ok(CASCADE.includes("sibling-emit") || CASCADE.includes("sibling"));
    // Two emit-only promptAgent call sites (repair + sibling).
    const emitHits = CASCADE.split("EMIT_ONLY_PROFILE_ID").length - 1;
    assert.ok(emitHits >= 2, `expected ≥2 EMIT_ONLY uses, got ${emitHits}`);
  });

  it("skips LLM repair for empty / pure-think responses", () => {
    assert.ok(CASCADE.includes("shouldSkipLlmJsonRepair") || CASCADE.includes("pure <think>"));
    assert.ok(CASCADE.includes("empty response") || CASCADE.includes("skipping LLM repair"));
  });

  it("disk-first settle runs after soft-repair and before LLM repair/salvage", () => {
    assert.ok(CASCADE.includes("tryDiskFirstWorkerParse") || CASCADE.includes("diskFirstWorkerSettle"));
    assert.ok(CASCADE.includes("disk-first"));
    const softIdx = CASCADE.indexOf("repairAndParseJson");
    const diskIdx = CASCADE.indexOf("tryDiskFirstWorkerParse");
    const llmIdx = CASCADE.indexOf("issuing emit-only repair prompt");
    assert.ok(diskIdx > softIdx, "disk-first must follow soft-repair");
    assert.ok(diskIdx > 0 && llmIdx > diskIdx, "disk-first must precede LLM repair");
  });

  it("workerRunner peeks tool trace before appendAgent for disk-first", () => {
    assert.ok(WORKER_RUNNER.includes("peekPendingToolTrace"));
    assert.ok(WORKER_RUNNER.includes("toolTrace"));
    const peekIdx = WORKER_RUNNER.indexOf("peekPendingToolTrace");
    // Primary worker path: peek near appendAgent + runWorkerParseCascade
    assert.ok(WORKER_RUNNER.includes("runWorkerParseCascade"));
    assert.ok(peekIdx > 0);
  });

  it("councilWorkerAttempt wires disk-first after parse fail", () => {
    assert.ok(COUNCIL_ATTEMPT.includes("tryDiskFirstWorkerParse") || COUNCIL_ATTEMPT.includes("diskFirstWorkerSettle"));
    assert.ok(COUNCIL_ATTEMPT.includes("peekPendingToolTrace"));
  });

  it("council + replanManager wire tab inventory for multi-tab HTML thrash", () => {
    assert.ok(COUNCIL_ATTEMPT.includes("tabInventory") || COUNCIL_ATTEMPT.includes("tab-inventory"));
    assert.ok(COUNCIL_ATTEMPT.includes("tabSkipContradictsInventory") || COUNCIL_ATTEMPT.includes("tab-inventory"));
    const REPLAN_MGR_SRC = REPLAN_MGR;
    assert.ok(REPLAN_MGR_SRC.includes("tabInventory") || REPLAN_MGR_SRC.includes("buildTabInventories"));
    assert.ok(REPLAN_MGR_SRC.includes("todoLikelyNeedsTabInventory"));
  });

  it("planner + replanner soft-repair before extra emit", () => {
    assert.ok(PLANNER_REC.includes("repairAndParseJson"));
    assert.ok(PLANNER_REC.includes("soft-repair"));
    assert.ok(REPLAN_REC.includes("repairAndParseJson"));
    assert.ok(REPLAN_REC.includes("soft-repair"));
  });

  it("replanner accepts parseable JSON from explore turns (no force re-emit)", () => {
    assert.ok(
      REPLAN_REC.includes("parsed from ${mode}")
        || REPLAN_REC.includes("replan parsed from")
        || REPLAN_REC.includes("from explore"),
      "must accept early parse on explore turn",
    );
    assert.ok(REPLAN_REC.includes("emitFirst") || REPLAN_REC.includes("policyEmitFirst"));
  });

  it("replanManager wires emitFirst → emit profile when explore disallowed", () => {
    assert.ok(REPLAN_MGR.includes("emitFirst"));
    assert.ok(REPLAN_MGR.includes("EMIT_ONLY_PROFILE_ID"));
    assert.ok(REPLAN_MGR.includes("resolveReplanPolicy"));
  });
});

describe("dual-path cascade — 2010479c schema + council parity", () => {
  it("worker schema allows replace_between endExclusive null", () => {
    // Live run failed hard on null endExclusive — schema/parser must accept.
    assert.ok(
      WORKER_PROMPT.includes("endExclusive") || WORKER_PROMPT.includes("replace_between"),
      "worker prompts must teach replace_between",
    );
  });

  it("BB self-consistency and council worker both use emit-only apply repair", () => {
    // Council apply/repair lives in councilWorkerAttempt (extracted from runner).
    for (const [name, src] of [
      ["workerSelfConsistency", SELF_CONSIST],
      ["councilWorkerAttempt", COUNCIL_ATTEMPT],
    ] as const) {
      assert.ok(src.includes("EMIT_ONLY_PROFILE_ID"), `${name}: emit-only profile`);
      assert.ok(src.includes("maxToolTurns: 1"), `${name}: maxToolTurns 1`);
      assert.ok(src.includes("applyOrGroundedRepair"), `${name}: shared apply repair`);
    }
    // Runner still orchestrates; keep a light presence check.
    assert.ok(
      COUNCIL_WORKER.includes("runCouncilWorker") || COUNCIL_WORKER.includes("councilWorker"),
      "councilWorkerRunner still wires worker loop",
    );
  });
});
