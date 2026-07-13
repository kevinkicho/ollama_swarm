import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideCouncilLoopAfterCycle,
  softDoneIsSuccessfulCompletion,
} from "./councilSettlementPolicy.js";

describe("decideCouncilLoopAfterCycle", () => {
  const base = {
    isAutonomous: false,
    executionOnlyResume: false,
    closingRequested: false,
  };

  it("stop always breaks (hard terminal)", () => {
    const d = decideCouncilLoopAfterCycle("stop", {
      ...base,
      isAutonomous: true,
      earlyStopDetail: "ambition-complete: all criteria met",
    });
    assert.deepEqual(d, { action: "break", kind: "hard-stop" });
  });

  it("retry continues with delay for autonomous and finite", () => {
    for (const isAutonomous of [true, false]) {
      const d = decideCouncilLoopAfterCycle("retry", { ...base, isAutonomous });
      assert.equal(d.action, "continue");
      if (d.action === "continue") assert.equal(d.delayMs, 1000);
    }
  });

  it("soft done is terminal for autonomous (does not spin)", () => {
    const d = decideCouncilLoopAfterCycle("done", {
      ...base,
      isAutonomous: true,
    });
    assert.deepEqual(d, { action: "break", kind: "soft-done" });
  });

  it("soft done is terminal for finite rounds", () => {
    const d = decideCouncilLoopAfterCycle("done", base);
    assert.deepEqual(d, { action: "break", kind: "soft-done" });
  });

  it("execution-only resume completes on soft done", () => {
    const d = decideCouncilLoopAfterCycle("done", {
      ...base,
      isAutonomous: true,
      executionOnlyResume: true,
    });
    assert.deepEqual(d, { action: "break", kind: "resume-complete" });
  });

  it("closing requested breaks on soft done", () => {
    const d = decideCouncilLoopAfterCycle("done", {
      ...base,
      isAutonomous: true,
      closingRequested: true,
    });
    assert.deepEqual(d, { action: "break", kind: "closing" });
  });

  it("does not use earlyStopDetail to continue (policy never clears it)", () => {
    // Even with a stale detail, soft-done still breaks — callers must not wipe it.
    const d = decideCouncilLoopAfterCycle("done", {
      ...base,
      isAutonomous: true,
      earlyStopDetail: "should-not-be-cleared",
    });
    assert.deepEqual(d, { action: "break", kind: "soft-done" });
  });
});

describe("softDoneIsSuccessfulCompletion", () => {
  it("true when no early-stop detail", () => {
    assert.equal(softDoneIsSuccessfulCompletion(undefined), true);
  });
  it("false when hard stop reason was recorded", () => {
    assert.equal(softDoneIsSuccessfulCompletion("audit-stuck: same 2 criteria"), false);
  });
});
