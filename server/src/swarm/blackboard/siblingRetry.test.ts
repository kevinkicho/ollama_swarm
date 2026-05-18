import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withSiblingRetry, type SiblingRetryOpts } from "./siblingRetry.js";
import type { Agent } from "../../services/AgentManager.js";

function mockAgent(overrides?: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    index: 1,
    sessionId: "sess-1",
    model: "glm-5.1:cloud",
    cwd: "/test",
    port: 0,
    ...overrides,
  } as unknown as Agent;
}

function mkOpts(overrides?: Partial<SiblingRetryOpts>): SiblingRetryOpts {
  const agent = mockAgent(overrides?.agent as any);
  return {
    agent,
    modelAtEntry: "glm-5.1:cloud",
    logPrefix: `[${agent.id}]`,
    updateAgentModel: () => {},
    emit: () => {},
    getFallbackModel: () => "nemotron-3-super:cloud",
    reason: "sibling-retry: test reason",
    ...overrides,
  };
}

describe("withSiblingRetry", () => {
  it("returns false when isFallbackAttempt is true", async () => {
    let called = false;
    const result = await withSiblingRetry(
      mkOpts({ isFallbackAttempt: true }),
      async () => { called = true; },
    );
    assert.equal(result, false);
    assert.equal(called, false);
  });

  it("returns false when no fallback and no sibling model", async () => {
    const agent = mockAgent({ model: "unknown-model:cloud" });
    let called = false;
    const opts: SiblingRetryOpts = {
      agent,
      modelAtEntry: "unknown-model:cloud",
      logPrefix: `[${agent.id}]`,
      updateAgentModel: () => {},
      emit: () => {},
      getFallbackModel: () => undefined,
      reason: "test",
    };
    const result = await withSiblingRetry(
      opts,
      async () => { called = true; },
    );
    assert.equal(result, false);
    assert.equal(called, false);
  });

  it("returns false when fallback is same as current model", async () => {
    let called = false;
    const result = await withSiblingRetry(
      mkOpts({ getFallbackModel: () => "glm-5.1:cloud" }),
      async () => { called = true; },
    );
    assert.equal(result, false);
    assert.equal(called, false);
  });

  it("swaps model and emits model_shift on retry", async () => {
    const agent = mockAgent();
    const events: any[] = [];
    const upgrades: string[] = [];

    const result = await withSiblingRetry(
      mkOpts({
        agent,
        emit: (e) => events.push(e),
        updateAgentModel: (_id, m) => upgrades.push(m),
      }),
      async () => {},
    );

    assert.equal(result, true);
    assert.equal(events.length, 2); // shift + revert
    assert.equal(events[0].type, "model_shift");
    assert.equal(events[0].fromModel, "glm-5.1:cloud");
    assert.equal(events[0].toModel, "nemotron-3-super:cloud");
    assert.equal(events[0].rawError, undefined); // sibling-retry has no API error
    assert.equal(events[1].type, "model_shift");
    assert.equal(events[1].fromModel, "nemotron-3-super:cloud");
    assert.equal(events[1].toModel, "glm-5.1:cloud");
    assert.equal(upgrades[0], "nemotron-3-super:cloud");
    assert.equal(upgrades[1], "glm-5.1:cloud");
  });

  it("restores model in finally even when fn throws", async () => {
    const agent = mockAgent();
    const events: any[] = [];
    const upgrades: string[] = [];

    let threw = false;
    try {
      await withSiblingRetry(
        mkOpts({
          agent,
          emit: (e) => events.push(e),
          updateAgentModel: (_id, m) => upgrades.push(m),
        }),
        async () => { throw new Error("test error"); },
      );
    } catch {
      threw = true;
    }

    assert.equal(threw, true);
    assert.equal(upgrades[1], "glm-5.1:cloud"); // reverted
    assert.equal(events[1].fromModel, "nemotron-3-super:cloud");
    assert.equal(events[1].toModel, "glm-5.1:cloud");
  });

  it("uses modelAtEntry for fromModel, not current agent.model", async () => {
    // Simulate provider-level failover having already mutated agent.model
    const agent = mockAgent({ model: "nemotron-3-super:cloud" }); // already swapped
    const events: any[] = [];

    await withSiblingRetry(
      mkOpts({
        agent,
        modelAtEntry: "glm-5.1:cloud", // the REAL original
        emit: (e) => events.push(e),
        getFallbackModel: () => "deepseek-v4-pro:cloud",
      }),
      async () => {},
    );

    assert.equal(events[0].fromModel, "glm-5.1:cloud"); // uses captured original
    assert.equal(events[0].toModel, "deepseek-v4-pro:cloud");
    assert.equal(events[1].fromModel, "deepseek-v4-pro:cloud");
    assert.equal(events[1].toModel, "glm-5.1:cloud"); // reverts to captured original
  });

  it("calls fn and returns true on success", async () => {
    let called = false;
    const result = await withSiblingRetry(
      mkOpts(),
      async () => { called = true; },
    );
    assert.equal(result, true);
    assert.equal(called, true);
  });

  it("uses siblingModelFor when getFallbackModel returns undefined", async () => {
    let fnCalled = false;
    const result = await withSiblingRetry(
      mkOpts({ getFallbackModel: () => undefined }),
      async () => { fnCalled = true; },
    );
    // glm-5.1 → nemotron via siblingModelFor
    assert.equal(result, true);
    assert.equal(fnCalled, true);
  });
});