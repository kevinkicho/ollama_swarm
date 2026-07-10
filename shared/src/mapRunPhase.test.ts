import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapV2PhaseToUi, resolveDisplayPhase, phasesDiverge } from "./mapRunPhase.js";

describe("mapRunPhase", () => {
  it("maps V2 phases to UI", () => {
    assert.equal(mapV2PhaseToUi("executing"), "executing");
    assert.equal(mapV2PhaseToUi("stopped"), "stopped");
    assert.equal(mapV2PhaseToUi("draining"), "draining");
  });

  it("prefers pause when v2 has pausedReason", () => {
    assert.equal(
      resolveDisplayPhase("executing", { phase: "executing", pausedReason: "quota" }),
      "paused",
    );
  });

  it("prefers V2 terminal over lagging V1 executing", () => {
    assert.equal(
      resolveDisplayPhase("executing", { phase: "stopped", pausedReason: undefined }),
      "stopped",
    );
    assert.equal(
      resolveDisplayPhase("planning", { phase: "completed", pausedReason: undefined }),
      "completed",
    );
  });

  it("keeps V1 mid-flight when V2 is mid-flight", () => {
    assert.equal(
      resolveDisplayPhase("planning", { phase: "planning", pausedReason: undefined }),
      "planning",
    );
  });

  it("detects divergence on terminal mismatch", () => {
    assert.equal(phasesDiverge("executing", "stopped"), true);
    assert.equal(phasesDiverge("executing", "executing"), false);
  });
});
