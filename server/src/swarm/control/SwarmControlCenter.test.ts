import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SwarmControlCenter } from "./SwarmControlCenter.js";
import type { Agent } from "../../services/AgentManager.js";

const coachAgent = {
  id: "agent-1",
  index: 1,
  sessionId: "s",
  model: "test",
  cwd: "",
} as Agent;

describe("SwarmControlCenter", () => {
  it("rule path retries on replanner skip storm (first hit, no arb)", async () => {
    const center = new SwarmControlCenter();
    const lines: string[] = [];
    // stuckCycles 0 → storms use rule only (arbitrator escalates at >= 2)
    const verdict = await center.evaluateStallGate({
      board: { open: 0, stale: 2, skipped: 8, committed: 0, total: 10 },
      contract: {
        missionStatement: "m",
        criteria: [
          { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet", addedAt: 0 },
          { id: "c2", description: "b", expectedFiles: ["b.ts"], status: "unmet", addedAt: 0 },
        ],
      },
      stuckCycles: 0,
      todos: [
        {
          id: "t1",
          description: "x",
          expectedFiles: ["a.ts"],
          status: "skipped",
          skippedReason: "replanner decided to skip: already done",
          replanCount: 1,
          createdAt: 0,
        },
        {
          id: "t2",
          description: "y",
          expectedFiles: ["b.ts"],
          status: "skipped",
          skippedReason: "replanner decided to skip: out of scope",
          replanCount: 1,
          createdAt: 0,
        },
        {
          id: "t3",
          description: "z",
          expectedFiles: ["c.ts"],
          status: "skipped",
          skippedReason: "replanner decided to skip: done",
          replanCount: 1,
          createdAt: 0,
        },
      ],
      coachAgent,
      appendSystem: (msg) => lines.push(msg),
    });
    assert.equal(verdict?.action, "retry");
    assert.equal(verdict?.source, "rule");
    assert.ok(verdict?.plannerHint);
    assert.ok(lines.some((l) => l.includes("[control] Stall gate (rule)")));
    assert.ok(!lines.some((l) => l.includes("Stall arbitrator invoked")));
  });

  it("no-activity returns retry with planner hint (not null)", async () => {
    const center = new SwarmControlCenter();
    const lines: string[] = [];
    const verdict = await center.evaluateStallGate({
      board: { open: 0, stale: 0, skipped: 0, committed: 0, total: 0 },
      contract: {
        missionStatement: "m",
        criteria: [
          { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet", addedAt: 0 },
        ],
      },
      stuckCycles: 0,
      todos: [],
      coachAgent,
      appendSystem: (msg) => lines.push(msg),
    });
    assert.equal(verdict?.action, "retry");
    assert.equal(verdict?.source, "rule");
    assert.ok(verdict?.plannerHint);
    assert.match(verdict!.rationale, /No board activity/i);
  });

  it("storm with stuckCycles>=2 attempts arbitrator then falls back to rule", async () => {
    const center = new SwarmControlCenter();
    const lines: string[] = [];
    // chatOnce will fail without a real agent session — arb returns null → rule fallback
    const verdict = await center.evaluateStallGate({
      board: { open: 0, stale: 4, skipped: 0, committed: 0, total: 4 },
      contract: {
        missionStatement: "m",
        criteria: [
          { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet", addedAt: 0 },
        ],
      },
      stuckCycles: 2,
      todos: [
        {
          id: "t1",
          description: "x",
          expectedFiles: ["a.ts"],
          status: "stale",
          staleReason: "hunk apply failed",
          replanCount: 0,
          createdAt: 0,
        },
        {
          id: "t2",
          description: "y",
          expectedFiles: ["b.ts"],
          status: "stale",
          staleReason: "parse fail",
          replanCount: 0,
          createdAt: 0,
        },
        {
          id: "t3",
          description: "z",
          expectedFiles: ["c.ts"],
          status: "stale",
          staleReason: "timeout",
          replanCount: 0,
          createdAt: 0,
        },
      ],
      coachAgent,
      appendSystem: (msg) => lines.push(msg),
    });
    assert.ok(lines.some((l) => l.includes("Stall arbitrator invoked")));
    // Fallback to rule reject-storm
    assert.equal(verdict?.action, "retry");
    assert.equal(verdict?.source, "rule");
  });

  it("consumeSessionPlannerHint is one-shot", async () => {
    const center = new SwarmControlCenter();
    await center.evaluateStallGate({
      board: { open: 0, stale: 0, skipped: 0, committed: 0, total: 0 },
      contract: {
        missionStatement: "m",
        criteria: [
          { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet", addedAt: 0 },
        ],
      },
      stuckCycles: 0,
      todos: [],
      coachAgent,
      appendSystem: () => {},
    });
    const h1 = center.consumeSessionPlannerHint();
    const h2 = center.consumeSessionPlannerHint();
    assert.ok(h1 && h1.length > 0);
    assert.equal(h2, undefined);
  });
});
