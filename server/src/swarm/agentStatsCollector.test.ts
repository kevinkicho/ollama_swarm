import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import type { Agent } from "../services/AgentManager.js";

// Stub agents — AgentStatsCollector only reads id + index. Rest is unused.
function stubAgent(index: number): Agent {
  return {
    id: `agent-${index}`,
    index,
    port: 0,
    sessionId: "",
    model: "test-model",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
  };
}

describe("AgentStatsCollector — reset + register", () => {
  it("produces an empty row set when no agents are registered", () => {
    const c = new AgentStatsCollector();
    assert.deepEqual(c.buildPerAgentStats(), []);
  });

  it("registers each agent and returns one row per registered agent", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1), stubAgent(2), stubAgent(3)]);
    const rows = c.buildPerAgentStats();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.agentId), ["agent-1", "agent-2", "agent-3"]);
    assert.deepEqual(rows.map((r) => r.agentIndex), [1, 2, 3]);
  });

  it("sorts rows by agentIndex even if registerAgents gets out-of-order input", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(3), stubAgent(1), stubAgent(2)]);
    const rows = c.buildPerAgentStats();
    assert.deepEqual(rows.map((r) => r.agentIndex), [1, 2, 3]);
  });

  it("reset() drops the roster and every counter", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1)]);
    c.countTurn("agent-1");
    c.onTiming("agent-1", true, 100);
    c.onRetry("agent-1");
    c.reset();
    assert.deepEqual(c.buildPerAgentStats(), []);
  });
});

describe("AgentStatsCollector — turn / attempt / retry counters", () => {
  it("countTurn bumps turnsTaken per-agent", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1), stubAgent(2)]);
    c.countTurn("agent-1");
    c.countTurn("agent-1");
    c.countTurn("agent-2");
    const rows = c.buildPerAgentStats();
    assert.equal(rows[0].turnsTaken, 2);
    assert.equal(rows[1].turnsTaken, 1);
  });

  it("onTiming bumps totalAttempts even on failure, but only records latency on success", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1)]);
    c.onTiming("agent-1", true, 100);
    c.onTiming("agent-1", false, 200); // failed: no latency sample
    c.onTiming("agent-1", true, 300);
    const row = c.buildPerAgentStats()[0];
    assert.equal(row.totalAttempts, 3);
    assert.equal(row.successfulAttempts, 2);
    // Mean over successful latency samples only: (100+300)/2 = 200
    assert.equal(row.meanLatencyMs, 200);
  });

  it("onRetry bumps totalRetries independently of totalAttempts", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1)]);
    // Simulate an agent that retried twice before its third attempt succeeded.
    c.onTiming("agent-1", false, 0);
    c.onRetry("agent-1");
    c.onTiming("agent-1", false, 0);
    c.onRetry("agent-1");
    c.onTiming("agent-1", true, 500);
    const row = c.buildPerAgentStats()[0];
    assert.equal(row.totalAttempts, 3);
    assert.equal(row.totalRetries, 2);
    assert.equal(row.successfulAttempts, 1);
    assert.equal(row.meanLatencyMs, 500);
  });
});

describe("AgentStatsCollector — buildPerAgentStats output shape", () => {
  it("fills defaults (zero / null) for an agent that has no data", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1)]);
    const row = c.buildPerAgentStats()[0];
    assert.equal(row.turnsTaken, 0);
    assert.equal(row.totalAttempts, 0);
    assert.equal(row.totalRetries, 0);
    assert.equal(row.successfulAttempts, 0);
    assert.equal(row.meanLatencyMs, null);
    assert.equal(row.p50LatencyMs, null);
    assert.equal(row.p95LatencyMs, null);
    assert.equal(row.tokensIn, null);
    assert.equal(row.tokensOut, null);
  });

  it("computes p50 and p95 over a distribution of latency samples", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1)]);
    for (const ms of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
      c.onTiming("agent-1", true, ms);
    }
    const row = c.buildPerAgentStats()[0];
    assert.equal(row.successfulAttempts, 10);
    // Nearest-rank percentile matches computeLatencyStats semantics.
    assert.equal(row.p50LatencyMs, 500);
    assert.equal(row.p95LatencyMs, 1000);
  });

  it("only reports rows for registered agents, even if onTiming is called for an unregistered id", () => {
    const c = new AgentStatsCollector();
    c.registerAgents([stubAgent(1)]);
    c.onTiming("agent-1", true, 100);
    c.onTiming("agent-99", true, 200); // not registered
    const rows = c.buildPerAgentStats();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agentId, "agent-1");
  });
});
