import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildScopedUiContract,
  inferScopedUiExpectedFiles,
  isScopedUiDirective,
  PLANNING_FAST_PATH_EXCLUDED_PRESETS,
  resolvePlanningFastPath,
  shouldRunGoalPrePass,
  shouldSkipContractDerivation,
  shouldSkipPlannerAfterContractFailure,
  resolveContractExploreProfile,
} from "./planningPolicy.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";

describe("planningPolicy", () => {
  it("skips goal pre-pass for substantial directive by default", () => {
    const cfg = { userDirective: "x".repeat(100) } as RunConfig;
    assert.equal(shouldRunGoalPrePass(cfg), false);
  });

  it("runs goal pre-pass when directive absent", () => {
    assert.equal(shouldRunGoalPrePass({} as RunConfig), true);
  });

  it("runs goal pre-pass for substantial directive when autoGenerateGoals true", () => {
    const cfg = { userDirective: "x".repeat(100), autoGenerateGoals: true } as RunConfig;
    assert.equal(shouldRunGoalPrePass(cfg), true);
  });

  it("skips planner after transport failure", () => {
    assert.equal(shouldSkipPlannerAfterContractFailure("transport: drain: stuck prompt"), true);
    assert.equal(shouldSkipPlannerAfterContractFailure("parse failed"), false);
  });

  it("does not skip planner after think-guard salvage", () => {
    assert.equal(
      shouldSkipPlannerAfterContractFailure("think-guard-salvage: think stream exceeded 112,000 chars (soft)"),
      false,
    );
  });

  it("uses swarm-read for contract when endpoint catalog present", () => {
    const seed = {
      endpointCatalogBlock: "=== ENDPOINT CATALOG ===\n/api/foo",
    } as PlannerSeed;
    assert.equal(resolveContractExploreProfile(seed, {}), "swarm-read");
  });

  it("resolvePlanningFastPath excludes stigmergy and map-reduce", () => {
    assert.equal(
      resolvePlanningFastPath({ preset: "stigmergy", planningFastPath: true } as RunConfig),
      false,
    );
    assert.equal(
      resolvePlanningFastPath({ preset: "map-reduce", planningFastPath: true } as RunConfig),
      false,
    );
    assert.equal(
      resolvePlanningFastPath({ preset: "blackboard", planningFastPath: true } as RunConfig),
      true,
    );
    assert.equal(PLANNING_FAST_PATH_EXCLUDED_PRESETS.has("stigmergy"), true);
  });

  it("detects scoped UI directives", () => {
    const d =
      "Fix the Drain button tooltip in SwarmView.tsx when planning has zero claims — show why drain is disabled.";
    assert.equal(isScopedUiDirective(d), true);
    assert.equal(isScopedUiDirective("short ui fix"), false);
  });

  it("infers UI expected files from excerpts", () => {
    const seed = {
      codeContextExcerpts: [{ path: "web/src/components/SwarmView.tsx", excerpt: "..." }],
      repoFiles: [],
    } as PlannerSeed;
    const files = inferScopedUiExpectedFiles(seed, "Update SwarmView tooltip");
    assert.deepEqual(files, ["web/src/components/SwarmView.tsx"]);
  });

  it("buildScopedUiContract wraps directive", () => {
    const c = buildScopedUiContract("Fix tooltip in SwarmView", ["web/src/components/SwarmView.tsx"]);
    assert.equal(c.criteria.length, 1);
    assert.deepEqual(c.criteria[0]!.expectedFiles, ["web/src/components/SwarmView.tsx"]);
  });

  it("shouldSkipContractDerivation for scoped UI + fast path + excerpts", () => {
    const cfg = {
      preset: "blackboard",
      planningFastPath: true,
      userDirective:
        "Fix the Drain button tooltip in SwarmView.tsx when planning has zero claims.",
    } as RunConfig;
    const seed = {
      userDirective: cfg.userDirective,
      codeContextExcerpts: [{ path: "web/src/components/SwarmView.tsx", excerpt: "x" }],
      repoFiles: [],
    } as PlannerSeed;
    assert.equal(shouldSkipContractDerivation(cfg, seed), true);
  });

  it("honors explicit skipContractDerivation on blackboard", () => {
    const cfg = { preset: "blackboard", skipContractDerivation: true } as RunConfig;
    assert.equal(shouldSkipContractDerivation(cfg, {} as PlannerSeed), true);
  });
});