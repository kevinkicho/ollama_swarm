import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRunResearchPrePass } from "./researchPrePass.js";
import type { PlannerSeed } from "./prompts/planner.js";
import type { RunConfig } from "../SwarmRunner.js";

function seed(overrides: Partial<PlannerSeed> = {}): PlannerSeed {
  return {
    repoUrl: "https://example.com/r",
    clonePath: "/tmp/clone",
    topLevel: [],
    repoFiles: [],
    readmeExcerpt: null,
    webToolsEnabled: true,
    ...overrides,
  };
}

describe("shouldRunResearchPrePass", () => {
  it("skips when web tools disabled", () => {
    const cfg = { repoUrl: "x", userDirective: "research papers" } as RunConfig;
    assert.equal(shouldRunResearchPrePass(cfg, seed({ webToolsEnabled: false })), false);
  });

  it("skips when research notes already present", () => {
    const cfg = { repoUrl: "x", webTools: true } as RunConfig;
    assert.equal(
      shouldRunResearchPrePass(cfg, seed({ researchNotes: "already done" })),
      false,
    );
  });

  it("runs when web tools on and directive present", () => {
    const cfg = { repoUrl: "x", webTools: true } as RunConfig;
    assert.equal(
      shouldRunResearchPrePass(cfg, seed({ userDirective: "literature review" })),
      true,
    );
  });
});