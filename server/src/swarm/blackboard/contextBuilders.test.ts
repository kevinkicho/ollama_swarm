import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Agent, AgentManager } from "../../services/AgentManager.js";
import { emitAgentActivity } from "./promptRunner.js";

/** Regression for run 4085e600: contract/planner contexts must pass manager into emitAgentActivity. */
describe("emitAgentActivity manager requirement", () => {
  it("throws when manager is undefined (4085e600 crash signature)", () => {
    const agent: Agent = {
      id: "agent-1",
      index: 1,
      model: "test",
      port: 0,
      sessionId: "s1",
      cwd: "/tmp",
    };
    assert.throws(
      () =>
        emitAgentActivity(agent, undefined as unknown as AgentManager, () => {}, {
          kind: "contract",
          label: "contract draft",
          attempt: 1,
          maxAttempts: 1,
        }),
      /markStatus/,
    );
  });

  it("calls manager.markStatus when manager is wired", () => {
    const agent: Agent = {
      id: "agent-1",
      index: 1,
      model: "test",
      port: 0,
      sessionId: "s1",
      cwd: "/tmp",
    };
    let called = false;
    const manager = {
      markStatus: () => {
        called = true;
      },
    } as unknown as AgentManager;
    emitAgentActivity(agent, manager, () => {}, {
      kind: "contract",
      label: "contract draft",
      attempt: 1,
      maxAttempts: 1,
    });
    assert.equal(called, true);
  });
});