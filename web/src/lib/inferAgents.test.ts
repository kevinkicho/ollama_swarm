import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferAgentsFromSnapshot } from "./inferAgents";

describe("inferAgentsFromSnapshot", () => {
  it("uses topology when agents array is empty", () => {
    const agents = inferAgentsFromSnapshot({
      agents: [],
      runConfig: {
        agentCount: 2,
        topology: {
          agents: [
            { index: 1, role: "planner", model: "m1" },
            { index: 2, role: "worker", model: "m2" },
          ],
        },
      },
    });
    assert.equal(agents.length, 2);
    assert.equal(agents[1]!.model, "m2");
  });

  it("parses ready lines from transcript", () => {
    const agents = inferAgentsFromSnapshot({
      transcript: [
        { id: "1", role: "system", text: "Worker agent agent-5 ready (model=glm)", ts: 1 },
      ],
    });
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.index, 5);
  });
});