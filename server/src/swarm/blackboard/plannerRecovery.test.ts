import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "plannerRecovery.ts"),
  "utf8",
);

describe("plannerRecovery — explore vs emit", () => {
  it("passes JSON schema only on emit-only attempts", () => {
    assert.match(SRC, /useEmitOnly \? opts\.jsonSchema : undefined/);
    assert.doesNotMatch(SRC, /useEmitOnly \? opts\.jsonSchema : opts\.jsonSchema/);
  });

  it("does not treat explore-turn non-JSON as parse failed", () => {
    assert.match(SRC, /explore complete/);
    assert.match(SRC, /if \(!useEmitOnly\)/);
  });

  it("uses rule-based JSON extract before failing emit", () => {
    assert.match(SRC, /tryParseWithRuleBasedExtract/);
    assert.match(SRC, /extractJsonCandidate/);
  });

  it("auditor salvage replaces prose diagnostic", () => {
    assert.match(SRC, /runPlannerAuditorSalvage/);
    assert.doesNotMatch(SRC, /runPlannerParseDiagnostic/);
  });

  it("supports seed-direct emit (D12) on attempt 1", () => {
    assert.match(SRC, /emitDirectFromSeed/);
    assert.match(SRC, /seed-direct emit/);
    assert.match(SRC, /emitDirectFromSeed && attempt === 1/);
  });
});