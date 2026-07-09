import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_BUILDER = readFileSync(
  join(here, "blackboard", "contractBuilder.ts"),
  "utf8",
);
const COUNCIL_ADAPTER = readFileSync(join(here, "councilAdapter.ts"), "utf8");

describe("council contract drafts use repo tools", () => {
  it("shared helper runs explore then emit with tool profiles", () => {
    assert.match(CONTRACT_BUILDER, /runCouncilContractDraftForAgent/);
    assert.match(CONTRACT_BUILDER, /resolveToolProfile\("planner"/);
    assert.match(CONTRACT_BUILDER, /emitProfile = EMIT_ONLY_PROFILE_ID/);
    assert.match(CONTRACT_BUILDER, /contract explore/);
    assert.match(CONTRACT_BUILDER, /buildFirstPassContractRepairPrompt/);
  });

  it("skips emit when explore already yields a grounded contract (no duplicate bubbles)", () => {
    const fnBlock = CONTRACT_BUILDER.slice(
      CONTRACT_BUILDER.indexOf("export async function runCouncilContractDraftForAgent"),
      CONTRACT_BUILDER.indexOf("export async function runFirstPassContractOrchestrator"),
    );
    assert.match(fnBlock, /parseFirstPassContractResponse\(exploreResponse\)/);
    assert.match(fnBlock, /validateContractGrounding/);
    assert.match(fnBlock, /skipping redundant emit/);
    assert.match(fnBlock, /emitRepairReason/);
  });

  it("tryCouncilContract does not call tool-free swarm profile for drafts", () => {
    const tryBlock = CONTRACT_BUILDER.slice(
      CONTRACT_BUILDER.indexOf("export async function tryCouncilContract"),
      CONTRACT_BUILDER.indexOf("export async function tryResumeContract"),
    );
    assert.doesNotMatch(tryBlock, /promptAgent\([^)]*"swarm"/);
    assert.match(tryBlock, /runCouncilContractDraftForAgent/);
  });

  it("CouncilRunner adapter uses the shared explore→emit draft helper", () => {
    const deriveBlock = COUNCIL_ADAPTER.slice(
      COUNCIL_ADAPTER.indexOf("export async function runContractDerivation"),
      COUNCIL_ADAPTER.indexOf("function finalizeContract"),
    );
    assert.doesNotMatch(deriveBlock, /"swarm",\s*"json"/);
    assert.match(deriveBlock, /runCouncilContractDraftForAgent/);
  });
});