import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowsUnboundedToolTurns,
  effectiveToolProfileId,
  isWebToolsEnabled,
  resolveDiscussionProfileId,
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
    assert.equal(resolveToolProfileId("worker", { webTools: false }), "swarm-read");
    assert.equal(resolveToolProfileId("worker", { webTools: true }), "swarm-research");
    assert.equal(resolveToolProfileId("auditor", { webTools: true }), "swarm-research");
    assert.equal(resolveToolProfileId("auditor", {}), "swarm-read");
    assert.equal(resolveToolProfileId("planner", { webTools: true }), "swarm-planner");
    assert.equal(resolveToolProfileId("planner", {}), "swarm-planner");
    assert.equal(resolveToolProfileId("worker-build", { webTools: true }), "swarm-builder-research");
  });

  it("toolingMatrix lists all blackboard roles", () => {
    const rows = toolingMatrix({ webTools: true });
    assert.equal(rows.length, 4);
    assert.ok(rows.some((r) => r.role === "Worker" && r.tools.includes("web_search")));
  });

  it("effectiveToolProfileId upgrades swarm-read when web tools on", () => {
    assert.equal(effectiveToolProfileId("swarm-read", {}), "swarm-read");
    assert.equal(effectiveToolProfileId("swarm-read", { webTools: true }), "swarm-research");
    assert.equal(effectiveToolProfileId("swarm-planner", { webTools: true }), "swarm-planner");
  });

  it("resolveDiscussionProfileId mirrors read/build roles", () => {
    assert.equal(resolveDiscussionProfileId("reader", { webTools: true }), "swarm-research");
    assert.equal(resolveDiscussionProfileId("builder", { webTools: true }), "swarm-builder-research");
  });

  it("allowsUnboundedToolTurns includes worker read profile", () => {
    assert.equal(allowsUnboundedToolTurns("swarm-read"), true);
    assert.equal(allowsUnboundedToolTurns("swarm"), false);
  });

});