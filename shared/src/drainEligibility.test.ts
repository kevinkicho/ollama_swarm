import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDrainEligible } from "./drainEligibility.js";

describe("isDrainEligible", () => {
  it("rejects planning phase with zero claims", () => {
    assert.equal(
      isDrainEligible({ phase: "planning", claimed: 0, pendingCommit: 0 }),
      false,
    );
  });

  it("accepts executing with claimed todos", () => {
    assert.equal(
      isDrainEligible({ phase: "executing", claimed: 2, pendingCommit: 0 }),
      true,
    );
  });

  it("accepts pending-commit work", () => {
    assert.equal(
      isDrainEligible({ phase: "executing", claimed: 0, pendingCommit: 1 }),
      true,
    );
  });

  it("accepts executing phase with worker thinking and zero wire claims", () => {
    assert.equal(
      isDrainEligible({
        phase: "executing",
        claimed: 0,
        pendingCommit: 0,
        workerThinking: true,
      }),
      true,
    );
  });

  it("rejects discussing phase even when lead agent is thinking", () => {
    assert.equal(
      isDrainEligible({
        phase: "discussing",
        claimed: 0,
        pendingCommit: 0,
        workerThinking: true,
      }),
      false,
    );
  });
});