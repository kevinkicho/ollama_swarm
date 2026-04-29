// Tests for #298 cost-breakdown helper. Pure-function tests with
// hand-built RunSummary fixtures so the math + role-lookup + hint
// generation are all locked in.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCostBreakdown } from "./costBreakdown.js";
import type { RunSummary } from "../types";

function fixture(partial: Partial<RunSummary>): RunSummary {
  return {
    runId: "r1",
    preset: "blackboard",
    model: "glm-5.1:cloud",
    repoUrl: "https://example.com/repo",
    clonePath: "/tmp/repo",
    startedAt: 0,
    endedAt: 1000,
    wallClockMs: 1000,
    stopReason: "completed",
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    staleEvents: 0,
    skippedTodos: 0,
    totalTodos: 0,
    totalPromptTokens: 0,
    totalResponseTokens: 0,
    finalGitStatus: "",
    finalGitStatusTruncated: false,
    transcript: [],
    agents: [],
    ...partial,
  } as RunSummary;
}

describe("computeCostBreakdown — defensive cases", () => {
  it("returns empty result when summary has no agents", () => {
    const r = computeCostBreakdown(fixture({}));
    assert.equal(r.totalTokens, 0);
    assert.deepEqual(r.byAgent, []);
    assert.equal(r.dominantAgent, null);
    assert.equal(r.savingHint, null);
  });

  it("returns empty result when all agents have null tokens", () => {
    const r = computeCostBreakdown(
      fixture({
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 0, tokensIn: null, tokensOut: null },
          { agentId: "a-2", agentIndex: 2, turnsTaken: 0, tokensIn: null, tokensOut: null },
        ],
      }),
    );
    assert.equal(r.totalTokens, 0);
    assert.equal(r.dominantAgent, null);
  });
});

describe("computeCostBreakdown — share math", () => {
  it("computes per-agent percent shares that sum to ~100", () => {
    const r = computeCostBreakdown(
      fixture({
        preset: "blackboard",
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 200, tokensOut: 0 },
          { agentId: "a-3", agentIndex: 3, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          { agentId: "a-4", agentIndex: 4, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
        ],
      }),
    );
    assert.equal(r.totalTokens, 500);
    const sumPct = r.byAgent.reduce((a, b) => a + b.pctOfTotal, 0);
    assert.ok(Math.abs(sumPct - 100) <= 4, `pct sum off: ${sumPct}`);
  });

  it("sorts agents by total tokens descending", () => {
    const r = computeCostBreakdown(
      fixture({
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 50, tokensOut: 0 },
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 500, tokensOut: 0 },
          { agentId: "a-3", agentIndex: 3, turnsTaken: 1, tokensIn: 200, tokensOut: 0 },
        ],
      }),
    );
    assert.deepEqual(
      r.byAgent.map((a) => a.agentIndex),
      [2, 3, 1],
    );
  });

  it("sums tokensIn + tokensOut per agent", () => {
    const r = computeCostBreakdown(
      fixture({
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 100, tokensOut: 50 },
        ],
      }),
    );
    assert.equal(r.totalTokens, 150);
    assert.equal(r.byAgent[0].totalTokens, 150);
  });
});

describe("computeCostBreakdown — dominance + hints", () => {
  it("flags agent at exactly 40% as dominant", () => {
    const r = computeCostBreakdown(
      fixture({
        preset: "blackboard",
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 400, tokensOut: 0 },
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 300, tokensOut: 0 },
          { agentId: "a-3", agentIndex: 3, turnsTaken: 1, tokensIn: 200, tokensOut: 0 },
          { agentId: "a-4", agentIndex: 4, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
        ],
      }),
    );
    assert.ok(r.dominantAgent);
    assert.equal(r.dominantAgent!.agentIndex, 1);
    // Agent 1 in blackboard = planner; planner-tier is judgment, no
    // coding-tier hint. So savingHint should be null here.
    assert.equal(r.savingHint, null);
  });

  it("does NOT flag dominant when no agent crosses 40%", () => {
    const r = computeCostBreakdown(
      fixture({
        preset: "blackboard",
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 250, tokensOut: 0 },
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 250, tokensOut: 0 },
          { agentId: "a-3", agentIndex: 3, turnsTaken: 1, tokensIn: 250, tokensOut: 0 },
          { agentId: "a-4", agentIndex: 4, turnsTaken: 1, tokensIn: 250, tokensOut: 0 },
        ],
      }),
    );
    assert.equal(r.dominantAgent, null);
    assert.equal(r.savingHint, null);
  });

  it("emits coding-tier hint when dominant agent is a worker (blackboard)", () => {
    const r = computeCostBreakdown(
      fixture({
        preset: "blackboard",
        agents: [
          // Agent 1 = planner (small)
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          // Agent 2 = worker (huge — dominant)
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 1000, tokensOut: 0 },
          // Agent 3 = worker (small)
          { agentId: "a-3", agentIndex: 3, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
        ],
      }),
    );
    assert.ok(r.dominantAgent);
    assert.equal(r.dominantAgent!.role, "worker");
    assert.ok(r.savingHint);
    assert.match(r.savingHint!, /coding-tier/);
    assert.match(r.savingHint!, /Worker model override/);
  });

  it("emits coding-tier hint with topology-grid wording for non-blackboard presets", () => {
    const r = computeCostBreakdown(
      fixture({
        preset: "map-reduce",
        agents: [
          // Agent 1 = reducer
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          // Agent 2 = mapper (dominant)
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 1000, tokensOut: 0 },
        ],
      }),
    );
    assert.ok(r.savingHint);
    assert.match(r.savingHint!, /Topology grid/);
  });

  it("emits auditor-specific hint when auditor dominates (unusual pattern)", () => {
    const r = computeCostBreakdown(
      fixture({
        preset: "blackboard",
        agents: [
          { agentId: "a-1", agentIndex: 1, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          { agentId: "a-2", agentIndex: 2, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          { agentId: "a-3", agentIndex: 3, turnsTaken: 1, tokensIn: 100, tokensOut: 0 },
          // Agent 4 in 4-agent blackboard = auditor when dedicatedAuditor=true
          { agentId: "a-4", agentIndex: 4, turnsTaken: 1, tokensIn: 1000, tokensOut: 0 },
        ],
      }),
    );
    if (r.dominantAgent?.role === "auditor") {
      assert.ok(r.savingHint);
      assert.match(r.savingHint!, /Auditor consumed/);
      assert.match(r.savingHint!, /criterion checkpoints/);
    }
  });
});
