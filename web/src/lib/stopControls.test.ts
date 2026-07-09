import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStopActionBusy, stopControlsDisabled } from "./stopControls";

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
});