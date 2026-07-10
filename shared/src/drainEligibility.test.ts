import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDrainEligible } from "./drainEligibility.js";

describe("isDrainEligible", () => {
  it("accepts planning phase for soft-stop (finish current turn then exit)", () => {
    assert.equal(
      isDrainEligible({ phase: "planning", claimed: 0, pendingCommit: 0 }),
      true,
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

  it("accepts discussing phase for soft-stop (council / discussion presets)", () => {
    assert.equal(
      isDrainEligible({
        phase: "discussing",
        claimed: 0,
        pendingCommit: 0,
        workerThinking: true,
      }),
      true,
    );
  });

  it("accepts boot/early phases so Drain is available as soon as the run starts", () => {
    assert.equal(
      isDrainEligible({ phase: "spawning", claimed: 0, pendingCommit: 0 }),
      true,
    );
    assert.equal(
      isDrainEligible({ phase: "cloning", claimed: 0, pendingCommit: 0 }),
      true,
    );
    assert.equal(
      isDrainEligible({ phase: "seeding", claimed: 0, pendingCommit: 0 }),
      true,
    );
  });

  it("rejects terminal / idle phases", () => {
    assert.equal(
      isDrainEligible({ phase: "idle", claimed: 0, pendingCommit: 0 }),
      false,
    );
    assert.equal(
      isDrainEligible({ phase: "stopped", claimed: 0, pendingCommit: 0 }),
      false,
    );
  });
});