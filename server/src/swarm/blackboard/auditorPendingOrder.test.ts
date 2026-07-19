/**
 * Regression: pending-commit review must not depend on criteria-verdict LLM success.
 * Live blackboard no-progress runs (11b4e505, 4bd7f7f6, 72f72773, 5a33a5f7) stranded
 * pending commits when auditor think-only/context-overflow aborted the LLM path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(join(__dirname, "auditorRunCore.ts"), "utf8");

describe("auditor pending-commit ordering (blackboard no-progress RCA)", () => {
  it("runAuditor calls reviewPendingCommits before criteria prompt", () => {
    const firstPending = CORE.indexOf("await reviewPendingCommits");
    // Call site (not import) of the criteria user prompt.
    const criteriaPrompt = CORE.indexOf("buildAuditorUserPrompt(seed");
    assert.ok(firstPending >= 0, "must call reviewPendingCommits");
    assert.ok(criteriaPrompt >= 0, "must still prompt auditor for criteria");
    assert.ok(
      firstPending < criteriaPrompt,
      "pending-commit drain must run before criteria LLM prompt",
    );
  });

  it("documents live no-progress run IDs in comment", () => {
    assert.match(CORE, /11b4e505|4bd7f7f6|72f72773/);
  });
});
