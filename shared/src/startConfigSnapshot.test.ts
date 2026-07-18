import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  captureStartConfigFromRunConfig,
  extractStartConfigFromSummary,
  modelsFromTopology,
} from "./startConfigSnapshot.js";

describe("startConfigSnapshot", () => {
  it("captures directive, topology, mcp, and caps from run config", () => {
    const snap = captureStartConfigFromRunConfig({
      repoUrl: "https://github.com/a/b",
      localPath: "C:\\work\\b",
      preset: "council",
      model: "m1",
      agentCount: 3,
      rounds: 0,
      userDirective: "build panels",
      webTools: true,
      autoApprove: true,
      mcpServers: "search=npx foo",
      councilSharedExplore: true,
      wallClockCapMs: 45 * 60_000,
      topology: {
        agents: [
          { index: 1, role: "drafter", model: "m1", removable: true },
          { index: 2, role: "drafter", model: "m2", removable: true },
        ],
      } as any,
    });
    assert.equal(snap.userDirective, "build panels");
    assert.equal(snap.directive, "build panels");
    assert.equal(snap.parentPath, "C:\\work\\b");
    assert.equal(snap.mcpServers, "search=npx foo");
    assert.equal(snap.wallClockCapMin, "45");
    assert.equal(snap.topology?.agents?.length, 2);
    assert.equal(snap.workerModel, "m1");
  });

  it("extracts startConfig nested + legacy top-level fields", () => {
    const sc = extractStartConfigFromSummary({
      preset: "blackboard",
      model: "mx",
      localPath: "/tmp/x",
      userDirective: "from top",
      startConfig: {
        userDirective: "from nested",
        mcpServers: "m=1",
        topology: {
          agents: [{ index: 1, role: "planner", model: "p1", removable: false }],
        },
      },
    });
    assert.equal(sc.userDirective, "from nested");
    assert.equal(sc.mcpServers, "m=1");
    assert.equal(sc.plannerModel, "p1");
    assert.equal(sc.presetId, "blackboard");
  });

  it("modelsFromTopology finds planner/worker/auditor roles", () => {
    const m = modelsFromTopology({
      agents: [
        { index: 1, role: "planner", model: "P", removable: false },
        { index: 2, role: "worker", model: "W", removable: true },
        { index: 3, role: "auditor", model: "A", removable: true },
      ],
    } as any);
    assert.deepEqual(m, { plannerModel: "P", workerModel: "W", auditorModel: "A" });
  });
});
