import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPLAN_RECOVERY_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "replannerRecovery.ts"),
  "utf8",
);
const REPLAN_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "replanManager.ts"),
  "utf8",
);
const AUDITOR_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "auditorRunner.ts"),
  "utf8",
);

describe("replanner recovery — auditor salvage", () => {
  it("routes replanner repair failures to auditor JSON salvage", () => {
    assert.match(REPLAN_RECOVERY_SRC, /runParseSalvage/);
    assert.match(REPLAN_RECOVERY_SRC, /kind: "replanner"/);
    assert.match(REPLAN_RECOVERY_SRC, /dedicatedAuditor/);
  });

  it("replanManager uses emit recovery loop", () => {
    assert.match(REPLAN_SRC, /runReplannerEmitRecovery/);
    assert.match(REPLAN_SRC, /buildReplannerRepairFullPrompt/);
  });
});

describe("auditorRunner — parse salvage extensions", () => {
  it("salvages hunk-review JSON after repair fails", () => {
    assert.match(AUDITOR_SRC, /kind: "hunk-review"/);
    assert.match(AUDITOR_SRC, /parseHunkReviewResponse\(salvage\.json\)/);
  });

  it("salvages auditor verdict JSON before sibling retry", () => {
    assert.match(AUDITOR_SRC, /kind: "auditor"/);
    assert.match(AUDITOR_SRC, /parseAuditorResponse\(salvage\.json\)/);
    assert.match(AUDITOR_SRC, /before sibling retry/);
  });
});