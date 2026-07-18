import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMIT_ONLY_PROFILE_ID,
  EXPLORE_MAX_TOOL_TURNS,
  EXPLORE_MAX_PLANNING_TOOL_TURNS,
  EXPLORE_MAX_CONTRACT_EXPLORE_TOOL_TURNS,
  CONTRACT_MERGE_MAX_TOOL_TURNS,
  contractExploreJsonNudge,
  resolveMaxToolTurnsForPlanningPhase,
  allowsUnboundedToolTurns,
  effectiveToolProfileId,
  isWebToolsEnabled,
  resolveDiscussionProfileId,
  resolveMaxToolTurnsForProfile,
  resolveToolProfileId,
  toolingMatrix,
  LITERATURE_RESEARCH_TOOLS,
} from "./toolProfiles.js";

describe("toolProfiles", () => {
  it("isWebToolsEnabled respects webTools and plannerTools", () => {
    assert.equal(isWebToolsEnabled({}), false);
    assert.equal(isWebToolsEnabled({ webTools: false }), false);
    assert.equal(isWebToolsEnabled({ webTools: true }), true);
    assert.equal(isWebToolsEnabled({ plannerTools: true }), true);
  });

  it("resolveToolProfileId gates web tools per role", () => {
    assert.equal(resolveToolProfileId("worker", { webTools: false }), "swarm-write");
    assert.equal(resolveToolProfileId("worker", { webTools: true }), "swarm-builder-research");
    assert.equal(resolveToolProfileId("auditor", { webTools: true }), "swarm-research");
    assert.equal(resolveToolProfileId("auditor", {}), "swarm-read");
    assert.equal(resolveToolProfileId("planner", { webTools: true }), "swarm-planner");
    assert.equal(resolveToolProfileId("planner", {}), "swarm-planner");
    assert.equal(resolveToolProfileId("worker-build", { webTools: true }), "swarm-builder-research");
  });

  it("autoApprove elevates every role to swarm-auto", () => {
    for (const role of ["planner", "worker", "worker-build", "auditor", "read"] as const) {
      assert.equal(resolveToolProfileId(role, { autoApprove: true }), "swarm-auto");
    }
    assert.equal(effectiveToolProfileId("swarm-read", { autoApprove: true }), "swarm-auto");
    assert.equal(allowsUnboundedToolTurns("swarm-auto"), true);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-auto"), 100);
  });

  it("toolingMatrix lists all blackboard roles", () => {
    const rows = toolingMatrix({ webTools: true });
    assert.equal(rows.length, 4);
    assert.ok(rows.some((r) => r.role === "Worker" && r.tools.includes("web_search")));
  });

  it("LITERATURE_RESEARCH_TOOLS is local-first then web (RR-C D3)", () => {
    assert.ok(LITERATURE_RESEARCH_TOOLS.includes("read"));
    assert.ok(LITERATURE_RESEARCH_TOOLS.includes("grep"));
    assert.ok(LITERATURE_RESEARCH_TOOLS.includes("list"));
    assert.ok(LITERATURE_RESEARCH_TOOLS.includes("glob"));
    assert.ok(LITERATURE_RESEARCH_TOOLS.includes("web_search"));
    assert.ok(LITERATURE_RESEARCH_TOOLS.includes("web_fetch"));
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

  it("emit-only profile is not elevated under autoApprove", () => {
    assert.equal(
      effectiveToolProfileId(EMIT_ONLY_PROFILE_ID, { autoApprove: true }),
      EMIT_ONLY_PROFILE_ID,
    );
    assert.equal(effectiveToolProfileId("swarm", { autoApprove: true, webTools: true }), "swarm");
  });

  it("resolveMaxToolTurnsForProfile tiers caps by profile", () => {
    assert.equal(EXPLORE_MAX_TOOL_TURNS, 100);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-planner"), 100);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-read"), 100);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-builder-research"), 100);
    assert.equal(resolveMaxToolTurnsForProfile("swarm-research"), 100);
    assert.equal(resolveMaxToolTurnsForProfile("swarm"), undefined);
  });

  it("resolveMaxToolTurnsForPlanningPhase uses tighter caps", () => {
    assert.equal(
      resolveMaxToolTurnsForPlanningPhase("contract-explore", {}),
      EXPLORE_MAX_CONTRACT_EXPLORE_TOOL_TURNS,
    );
    assert.equal(EXPLORE_MAX_CONTRACT_EXPLORE_TOOL_TURNS, 10);
    assert.equal(resolveMaxToolTurnsForPlanningPhase("contract-explore", { planningFastPath: true }), 6);
    assert.equal(resolveMaxToolTurnsForPlanningPhase("planner-todos-explore", {}), EXPLORE_MAX_PLANNING_TOOL_TURNS);
    assert.equal(resolveMaxToolTurnsForPlanningPhase("goal-pre-pass", { planningFastPath: true }), 4);
    assert.equal(CONTRACT_MERGE_MAX_TOOL_TURNS, 0);
    assert.equal(contractExploreJsonNudge().atTurn, 6);
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