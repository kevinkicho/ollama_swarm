import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displaySwarmPhase,
  isActiveSwarmPhase,
  isTerminalSwarmPhase,
} from "./swarmPhase.js";

describe("swarmPhase", () => {
  it("isTerminalSwarmPhase", () => {
    assert.equal(isTerminalSwarmPhase("stopped"), true);
    assert.equal(isTerminalSwarmPhase("planning"), false);
  });

  it("isActiveSwarmPhase", () => {
    assert.equal(isActiveSwarmPhase("executing"), true);
    assert.equal(isActiveSwarmPhase("idle"), false);
    assert.equal(isActiveSwarmPhase("stopped"), false);
  });

  it("displaySwarmPhase collapses granular phases", () => {
    assert.equal(displaySwarmPhase("planning"), "running");
    assert.equal(displaySwarmPhase("discussing"), "running");
    assert.equal(displaySwarmPhase("completed"), "completed");
    assert.equal(displaySwarmPhase("stopping"), "stopped");
  });
});