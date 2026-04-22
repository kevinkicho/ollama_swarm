import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { shouldRunFinalAudit, type FinalAuditInput } from "./finalAudit.js";

function input(overrides: Partial<FinalAuditInput> = {}): FinalAuditInput {
  return {
    errored: false,
    hasContract: true,
    allCriteriaResolved: false,
    terminationReason: "cap:wall-clock",
    auditInvocations: 0,
    maxInvocations: 5,
    userStopped: false,
    ...overrides,
  };
}

describe("shouldRunFinalAudit", () => {
  it("fires on wall-clock cap with unmet criteria and budget remaining", () => {
    assert.equal(shouldRunFinalAudit(input()), true);
  });

  it("fires on commits cap too (any terminationReason counts)", () => {
    assert.equal(
      shouldRunFinalAudit(input({ terminationReason: "cap:commits" })),
      true,
    );
  });

  it("fires on last available invocation slot", () => {
    assert.equal(
      shouldRunFinalAudit(input({ auditInvocations: 4, maxInvocations: 5 })),
      true,
    );
  });

  it("skips when the run errored", () => {
    assert.equal(shouldRunFinalAudit(input({ errored: true })), false);
  });

  it("skips when there is no contract", () => {
    assert.equal(shouldRunFinalAudit(input({ hasContract: false })), false);
  });

  it("skips when all criteria are already resolved", () => {
    assert.equal(
      shouldRunFinalAudit(input({ allCriteriaResolved: true })),
      false,
    );
  });

  it("skips when audit budget is already exhausted", () => {
    assert.equal(
      shouldRunFinalAudit(input({ auditInvocations: 5, maxInvocations: 5 })),
      false,
    );
  });

  it("skips on user-initiated stop", () => {
    assert.equal(shouldRunFinalAudit(input({ userStopped: true })), false);
  });

  it("skips on natural completion (no terminationReason)", () => {
    assert.equal(
      shouldRunFinalAudit(input({ terminationReason: undefined })),
      false,
    );
  });

  it("errored takes priority over eligible cap state", () => {
    assert.equal(
      shouldRunFinalAudit(
        input({ errored: true, terminationReason: "cap:wall-clock" }),
      ),
      false,
    );
  });

  it("userStopped takes priority over cap (defense-in-depth)", () => {
    // Not expected in practice — stop() doesn't set terminationReason — but
    // if both ever co-existed, user intent wins.
    assert.equal(
      shouldRunFinalAudit(
        input({ userStopped: true, terminationReason: "cap:wall-clock" }),
      ),
      false,
    );
  });
});
