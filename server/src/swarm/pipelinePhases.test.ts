import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_PIPELINE } from "./pipelinePhases.js";

describe("RESEARCH_PIPELINE", () => {
  it("chains council → map-reduce → blackboard", () => {
    assert.deepEqual(
      RESEARCH_PIPELINE.phases.map((p) => p.preset),
      ["council", "map-reduce", "blackboard"],
    );
    assert.equal(RESEARCH_PIPELINE.pipeMode, "both");
    assert.equal(RESEARCH_PIPELINE.pipeMaxEntries, 30);
  });
});