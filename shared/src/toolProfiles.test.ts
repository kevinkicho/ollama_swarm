import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMIT_ONLY_PROFILE_ID,
  EXPLORE_MAX_TOOL_TURNS,
  EXPLORE_MAX_PLANNING_TOOL_TURNS,
  resolveMaxToolTurnsForPlanningPhase,
  allowsUnboundedToolTurns,
  effectiveToolProfileId,
  isWebToolsEnabled,
  resolveDiscussionProfileId,
  resolveMaxToolTurnsForProfile,
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

  it("EMIT_ONLY_PROFILE_ID is tools-off swarm", () => {
    assert.equal(EMIT_ONLY_PROFILE_ID, "swarm");
  });

  it("resolveMaxToolTurnsForProfile tiers caps by profile", () => {
    assert.equal(EXPLORE_MAX_TOOL_TURNS, 20);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-planner"), 20);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-read"), 20);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-builder-research"), 40);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-research"), 35);
    assert.equal(resolveMaxToolTurnsForProfile("swarm"), undefined);
  });

  it("resolveMaxToolTurnsForPlanningPhase uses tighter caps", () => {
    assert.equal(resolveMaxToolTurnsForPlanningPhase("contract-explore", {}), EXPLORE_MAX_PLANNING_TOOL_TURNS);
    assert.equal(resolveMaxToolTurnsForPlanningPhase("goal-pre-pass", { planningFastPath: true }), 4);
  });

  it("workerJsonNudge and wall-clock defaults", async () => {
    const { workerJsonNudgeForProfile, defaultPromptWallClockMs, WORKER_JSON_NUDGE_TURN } =
      await import("./toolProfiles.js");
    assert.ok(workerJsonNudgeForProfile("swarm-builder"));
    assert.equal(workerJsonNudgeForProfile("swarm-builder")!.atTurn, WORKER_JSON_NUDGE_TURN);
    assert.equal(workerJsonNudgeForProfile("swarm-read"), undefined);
    assert.equal(defaultPromptWallClockMs("swarm-builder"), 120_000);
    assert.equal(defaultPromptWallClockMs("swarm-planner"), 180_000);
  });

});