import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isWebToolsEnabled,
  resolveToolProfileId,
  toolingMatrix,
} from "./toolProfiles.js";

describe("toolProfiles", () => {
  it("isWebToolsEnabled respects webTools and plannerTools", () => {
    assert.equal(isWebToolsEnabled({}), false);
    assert.equal(isWebToolsEnabled({ webTools: false }), false);
    assert.equal(isWebToolsEnabled({ webTools: true }), true);
    assert.equal(isWebToolsEnabled({ plannerTools: true }), true);
  });

  it("resolveToolProfileId gates web tools per role", () => {
    assert.equal(resolveToolProfileId("worker", { webTools: false }), "swarm");
    assert.equal(resolveToolProfileId("worker", { webTools: true }), "swarm-research");
    assert.equal(resolveToolProfileId("auditor", { webTools: true }), "swarm-research");
    assert.equal(resolveToolProfileId("auditor", {}), "swarm-read");
    assert.equal(resolveToolProfileId("planner", { webTools: true }), "swarm-planner");
    assert.equal(resolveToolProfileId("planner", {}), "swarm-read");
    assert.equal(resolveToolProfileId("worker-build", { webTools: true }), "swarm-builder-research");
  });

  it("toolingMatrix lists all blackboard roles", () => {
    const rows = toolingMatrix({ webTools: true });
    assert.equal(rows.length, 4);
    assert.ok(rows.some((r) => r.role === "Worker" && r.tools.includes("web_search")));
  });
});