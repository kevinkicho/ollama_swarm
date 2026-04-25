import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateContinuousMode } from "./continuousMode.js";

describe("validateContinuousMode (Task #132)", () => {
  it("returns null when continuous is not requested (no validation needed)", () => {
    assert.equal(
      validateContinuousMode({ continuous: false, preset: "council" }),
      null,
    );
    assert.equal(
      validateContinuousMode({ continuous: undefined, preset: "council" }),
      null,
    );
  });

  it("allows blackboard continuous mode without an explicit cap (built-in caps suffice)", () => {
    assert.equal(
      validateContinuousMode({ continuous: true, preset: "blackboard" }),
      null,
    );
  });

  it("rejects discussion-preset continuous mode without any cap", () => {
    const err = validateContinuousMode({ continuous: true, preset: "council" });
    assert.ok(err);
    assert.match(err!, /at least one budget cap/);
    // Error message must point users at the actual knobs to set.
    assert.match(err!, /tokenBudget/);
    assert.match(err!, /wallClockCapMs/);
  });

  it("allows discussion preset when tokenBudget is set", () => {
    assert.equal(
      validateContinuousMode({
        continuous: true,
        preset: "council",
        tokenBudget: 5_000_000,
      }),
      null,
    );
  });

  it("allows discussion preset when wallClockCapMs is set", () => {
    assert.equal(
      validateContinuousMode({
        continuous: true,
        preset: "round-robin",
        wallClockCapMs: 1_800_000,
      }),
      null,
    );
  });

  it("treats a zero-valued cap as 'no cap' (rejects)", () => {
    // A 0 budget is the same as no budget — it would never gate. The
    // route should reject so the user fixes the cap.
    const err = validateContinuousMode({
      continuous: true,
      preset: "council",
      tokenBudget: 0,
      wallClockCapMs: 0,
    });
    assert.ok(err);
  });

  it("accepts any caps combination (token only / clock only / both)", () => {
    assert.equal(
      validateContinuousMode({
        continuous: true,
        preset: "stigmergy",
        tokenBudget: 1_000,
        wallClockCapMs: 60_000,
      }),
      null,
    );
  });
});
