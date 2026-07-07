import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackAudit } from "./councilAuditor.js";
import { createEmptyLedger, appendLedgerObservation } from "./councilProgressLedger.js";
import type { ExitContract } from "./blackboard/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "councilAuditor.ts"), "utf8");

test("councilAuditor uses repair prompt before fallback (no brain)", () => {
  assert.match(SRC, /buildAuditorRepairPrompt/);
  assert.match(SRC, /issuing repair prompt/);
  assert.doesNotMatch(SRC, /tryBrainFallback/i, "council audit must not use in-run brain for parse recovery");
});

test("fallbackAudit keeps executable criterion unmet without ledger commit", async () => {
  const ledger = createEmptyLedger("run-1");
  const contract: ExitContract = {
    missionStatement: "test",
    criteria: [
      {
        id: "c1",
        description: "Implement predict_tc ML model",
        expectedFiles: ["scripts/predict_tc.py"],
        status: "unmet",
      },
    ],
  };
  const { updatedCriteria, newTodos } = await fallbackAudit(
    { localPath: __dirname, userDirective: "test" } as any,
    contract,
    [],
    ledger,
  );
  assert.equal(updatedCriteria[0].status, "unmet");
  assert.equal(newTodos.length, 1);
});

test("fallbackAudit does not mark met when ledger shows fails on same files", async () => {
  const ledger = createEmptyLedger("run-1");
  appendLedgerObservation(ledger, {
    kind: "fail",
    text: "JSON parse failed",
    cycle: 1,
    files: ["docs/foo.md"],
  });
  const contract: ExitContract = {
    missionStatement: "test",
    criteria: [
      {
        id: "c1",
        description: "Update documentation",
        expectedFiles: ["docs/foo.md"],
        status: "unmet",
      },
    ],
  };
  const { updatedCriteria } = await fallbackAudit(
    { localPath: join(__dirname, "..", ".."), userDirective: "test" } as any,
    contract,
    [],
    ledger,
  );
  assert.equal(updatedCriteria[0].status, "unmet");
});