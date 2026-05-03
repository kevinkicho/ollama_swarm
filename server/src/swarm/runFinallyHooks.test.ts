// 2026-05-03 (Phase D): unit tests for runDiscussionCloseOut.
// Validates the orchestration shape (gating + ordering) without
// reaching into runEndReflection's implementation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import type { AgentManager, Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { SwarmPhase } from "../types.js";

function fakeCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    repoUrl: "https://x",
    localPath: "/tmp/x",
    agentCount: 3,
    rounds: 2,
    model: "test",
    preset: "council",
    runId: "run-abc",
    ...overrides,
  } as RunConfig;
}

function fakeManager(opts?: { killResult?: { released: number; total: number } }): AgentManager {
  return {
    list: () => [],
    killAll: async () => opts?.killResult ?? { released: 3, total: 3, killed: [] },
  } as unknown as AgentManager;
}

describe("runDiscussionCloseOut", () => {
  it("happy path: writeSummary fires + killAll + setPhase('completed')", async () => {
    const log: string[] = [];
    const phaseSet: SwarmPhase[] = [];
    let writeSummaryCalls = 0;
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      stopping: false,
      round: 2,
      currentPhase: "discussing",
      manager: fakeManager(),
      appendSystem: (t) => log.push(t),
      setPhase: (p) => phaseSet.push(p),
      writeSummary: async () => { writeSummaryCalls++; },
      hooks: {},
    });
    assert.equal(writeSummaryCalls, 1);
    assert.deepEqual(phaseSet, ["completed"]);
    assert.ok(log.length >= 1, "must emit kill-result line");
  });

  it("when stopping=true, skips killAll + skips setPhase", async () => {
    const phaseSet: SwarmPhase[] = [];
    let killCalls = 0;
    const manager = {
      list: () => [],
      killAll: async () => { killCalls++; return { released: 0, total: 0, killed: [] }; },
    } as unknown as AgentManager;
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      stopping: true,
      round: 2,
      currentPhase: "stopping",
      manager,
      appendSystem: () => {},
      setPhase: (p) => phaseSet.push(p),
      writeSummary: async () => {},
      hooks: {},
    });
    assert.equal(killCalls, 0);
    assert.equal(phaseSet.length, 0);
  });

  it("when crashMessage set, skips reflection (still writes summary + killAll)", async () => {
    let reflectionAgentCalls = 0;
    let writeSummaryCalls = 0;
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      crashMessage: "boom",
      stopping: false,
      round: 1,
      currentPhase: "failed",
      manager: fakeManager(),
      appendSystem: () => {},
      setPhase: () => {},
      writeSummary: async () => { writeSummaryCalls++; },
      hooks: {
        pickReflectionAgent: () => { reflectionAgentCalls++; return null; },
      },
    });
    assert.equal(reflectionAgentCalls, 0, "reflection hook not even called when crash present");
    assert.equal(writeSummaryCalls, 1, "writeSummary still fires after crash");
  });

  it("reflection hook returning null skips runEndReflection (MoA case)", async () => {
    // No throw expected; hook returning null is a clean opt-out.
    let writeSummaryCalls = 0;
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      stopping: false,
      round: 2,
      currentPhase: "discussing",
      manager: fakeManager(),
      appendSystem: () => {},
      setPhase: () => {},
      writeSummary: async () => { writeSummaryCalls++; },
      hooks: {
        pickReflectionAgent: () => null, // MoA-style opt-out
      },
    });
    assert.equal(writeSummaryCalls, 1);
  });

  it("shouldSetCompleted=false guards setPhase (MoA case when phase=failed)", async () => {
    const phaseSet: SwarmPhase[] = [];
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      stopping: false,
      round: 1,
      currentPhase: "failed",
      manager: fakeManager(),
      appendSystem: () => {},
      setPhase: (p) => phaseSet.push(p),
      writeSummary: async () => {},
      hooks: {
        shouldSetCompleted: (current) => current !== "failed",
      },
    });
    assert.equal(phaseSet.length, 0, "setPhase must not be called when guard returns false");
  });

  it("buildReflectionContext is called with round + earlyStopDetail", async () => {
    type State = { round: number; earlyStopDetail?: string };
    const captured: State[] = [];
    const fakeAgent = { id: "a-1", index: 1, port: 1, sessionId: "s-1" } as Agent;
    const manager = {
      list: () => [fakeAgent],
      killAll: async () => ({ released: 1, total: 1, killed: [] }),
    } as unknown as AgentManager;
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      stopping: false,
      round: 4,
      earlyStopDetail: "convergence-high",
      currentPhase: "discussing",
      manager,
      appendSystem: () => {},
      setPhase: () => {},
      writeSummary: async () => {},
      hooks: {
        pickReflectionAgent: (m) => m.list().find((a) => a.index === 1) ?? null,
        buildReflectionContext: (s) => {
          captured.push(s);
          return "mock-context";
        },
      },
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].round, 4);
    assert.equal(captured[0].earlyStopDetail, "convergence-high");
  });

  it("ordering: reflection BEFORE writeSummary BEFORE killAll/setPhase", async () => {
    const order: string[] = [];
    const fakeAgent = { id: "a-1", index: 1, port: 1, sessionId: "s-1" } as Agent;
    const manager = {
      list: () => [fakeAgent],
      killAll: async () => { order.push("killAll"); return { released: 1, total: 1, killed: [] }; },
    } as unknown as AgentManager;
    await runDiscussionCloseOut({
      cfg: fakeCfg(),
      stopping: false,
      round: 1,
      currentPhase: "discussing",
      manager,
      appendSystem: () => {},
      setPhase: () => order.push("setPhase"),
      writeSummary: async () => { order.push("writeSummary"); },
      hooks: {
        pickReflectionAgent: () => null, // skip reflection so we don't hit the network
      },
    });
    // Reflection skipped (null agent), then writeSummary, then killAll, then setPhase.
    assert.deepEqual(order, ["writeSummary", "killAll", "setPhase"]);
  });
});
