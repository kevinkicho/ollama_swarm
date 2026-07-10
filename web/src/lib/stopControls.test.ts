import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isStopActionBusy,
  stopControlsDisabled,
  hardStopDisabled,
  drainControlsDisabled,
  type PendingStopAction,
} from "./stopControls";

describe("stopControls", () => {
  it("isStopActionBusy — only blocks the run that initiated drain/stop", () => {
    assert.equal(isStopActionBusy("run-a", "run-a"), true);
    assert.equal(isStopActionBusy("run-a", "run-b"), false);
    assert.equal(isStopActionBusy(null, "run-b"), false);
  });

  it("stopControlsDisabled — other runs stay stoppable while one drains", () => {
    assert.equal(stopControlsDisabled("run-a", "run-b", true), false);
    assert.equal(stopControlsDisabled("run-a", "run-a", true), true);
    assert.equal(stopControlsDisabled(null, "run-b", false), true);
  });

  it("hardStopDisabled — stays enabled while drain is in flight or draining", () => {
    const drainPending: PendingStopAction = { runId: "run-a", kind: "drain" };
    assert.equal(hardStopDisabled(drainPending, "run-a", true), false);
    assert.equal(hardStopDisabled(null, "run-a", true), false);
    assert.equal(hardStopDisabled({ runId: "run-a", kind: "stop" }, "run-a", true), true);
    assert.equal(hardStopDisabled({ runId: "run-a", kind: "stop" }, "run-b", true), false);
    assert.equal(hardStopDisabled(null, "run-a", false), true);
  });

  it("drainControlsDisabled — blocks while any action in flight or already draining", () => {
    assert.equal(drainControlsDisabled(null, "run-a", true, true, "discussing"), false);
    assert.equal(
      drainControlsDisabled({ runId: "run-a", kind: "drain" }, "run-a", true, true, "discussing"),
      true,
    );
    assert.equal(
      drainControlsDisabled({ runId: "run-a", kind: "stop" }, "run-a", true, true, "discussing"),
      true,
    );
    assert.equal(drainControlsDisabled(null, "run-a", true, true, "draining"), true);
    assert.equal(drainControlsDisabled(null, "run-a", true, false, "discussing"), true);
    assert.equal(drainControlsDisabled(null, "run-b", true, true, "discussing"), false);
  });
});
