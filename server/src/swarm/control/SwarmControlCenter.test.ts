import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SwarmControlCenter } from "./SwarmControlCenter.js";

describe("SwarmControlCenter", () => {
  it("rule path backs off on replanner skip storm", async () => {
    const center = new SwarmControlCenter();
    const lines: string[] = [];
    const verdict = await center.evaluateStallGate({
      board: { open: 0, stale: 2, skipped: 8, committed: 0, total: 10 },
      contract: {
        missionStatement: "m",
        criteria: [
          { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet", addedAt: 0 },
          { id: "c2", description: "b", expectedFiles: ["b.ts"], status: "unmet", addedAt: 0 },
        ],
      },
      stuckCycles: 2,
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
      coachAgent: {
        id: "agent-1",
        index: 1,
        sessionId: "s",
        model: "test",
        cwd: "",
      },
      appendSystem: (msg) => lines.push(msg),
    });
    assert.equal(verdict?.action, "retry");
    assert.equal(verdict?.source, "rule");
    assert.ok(verdict?.plannerHint);
    assert.ok(lines.some((l) => l.includes("[control]")));
  });
});