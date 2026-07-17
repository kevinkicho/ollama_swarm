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
// Council draft/merge path extracted to councilContractBuilder.ts
const COUNCIL_CONTRACT = readFileSync(
  join(here, "blackboard", "councilContractBuilder.ts"),
  "utf8",
);
const COUNCIL_ADAPTER = readFileSync(join(here, "councilAdapter.ts"), "utf8");
const ALL_CONTRACT = CONTRACT_BUILDER + "\n" + COUNCIL_CONTRACT;

describe("council contract drafts use repo tools", () => {
  it("shared helper runs explore then emit with tool profiles", () => {
    assert.match(ALL_CONTRACT, /runCouncilContractDraftForAgent/);
    assert.match(ALL_CONTRACT, /resolveToolProfile\("planner"/);
    assert.match(ALL_CONTRACT, /emitProfile = EMIT_ONLY_PROFILE_ID/);
    assert.match(ALL_CONTRACT, /contract explore/);
    assert.match(ALL_CONTRACT, /buildFirstPassContractRepairPrompt/);
  });

  it("skips emit when explore already yields a grounded contract (no duplicate bubbles)", () => {
    const fnBlock = COUNCIL_CONTRACT.slice(
      COUNCIL_CONTRACT.indexOf("export async function runCouncilContractDraftForAgent"),
      COUNCIL_CONTRACT.indexOf("export async function runFirstPassContractOrchestrator"),
    );
    assert.match(fnBlock, /parseFirstPassContractResponse\(exploreResponse\)/);
    assert.match(fnBlock, /validateContractGrounding/);
    assert.match(fnBlock, /skipping redundant emit/);
    assert.match(fnBlock, /emitRepairReason/);
  });

  it("tryCouncilContract does not call tool-free swarm profile for drafts", () => {
    const tryBlock = COUNCIL_CONTRACT.slice(
      COUNCIL_CONTRACT.indexOf("export async function tryCouncilContract"),
      COUNCIL_CONTRACT.length,
    );
    assert.doesNotMatch(tryBlock, /promptAgent\([^)]*"swarm"/);
    assert.match(tryBlock, /runCouncilContractDraftForAgent/);
  });

  it("supports shared explore → emit-only council drafts", () => {
    assert.match(ALL_CONTRACT, /runCouncilSharedExplore/);
    assert.match(ALL_CONTRACT, /runCouncilContractEmitForAgent/);
    assert.match(ALL_CONTRACT, /buildCouncilContractEmitUserPrompt/);
    const tryBlock = COUNCIL_CONTRACT.slice(
      COUNCIL_CONTRACT.indexOf("export async function tryCouncilContract"),
      COUNCIL_CONTRACT.length,
    );
    assert.match(tryBlock, /councilSharedExplore/);
    assert.match(tryBlock, /shared explore complete/);
  });

  it("CouncilRunner adapter uses the shared explore→emit draft helper", () => {
    const deriveBlock = COUNCIL_ADAPTER.slice(
      COUNCIL_ADAPTER.indexOf("export async function runContractDerivation"),
      COUNCIL_ADAPTER.indexOf("function finalizeContract"),
    );
    assert.doesNotMatch(deriveBlock, /"swarm",\s*"json"/);
    assert.match(deriveBlock, /runCouncilContractDraftForAgent/);
    assert.match(deriveBlock, /councilSharedExplore/);
    assert.match(deriveBlock, /runCouncilSharedExplore/);
    assert.match(deriveBlock, /runCouncilContractEmitForAgent/);
    assert.match(deriveBlock, /shared explore complete/);
  });

  it("council adapter defaults multi-agent shared explore and emit-only merge (d3f56d9a)", () => {
    assert.match(COUNCIL_ADAPTER, /councilSharedExplore !== false/);
    assert.match(COUNCIL_ADAPTER, /CONTRACT_MERGE_MAX_TOOL_TURNS/);
    assert.match(COUNCIL_ADAPTER, /emit-only/);
    assert.match(COUNCIL_ADAPTER, /failedDraftAgentIds/);
    assert.match(COUNCIL_ADAPTER, /activity\?\.maxToolTurns/);
    assert.match(COUNCIL_ADAPTER, /contractExploreJsonNudge/);
    assert.match(COUNCIL_ADAPTER, /recordCycleFail/);
  });

  it("independent explore wires peer demote coordinator", () => {
    assert.match(COUNCIL_ADAPTER, /createPeerDraftCoordinator/);
    assert.match(COUNCIL_ADAPTER, /peerCoordinator\.registerAbort/);
    assert.match(COUNCIL_ADAPTER, /agentAbortSignals/);
    assert.match(COUNCIL_CONTRACT, /getPeerBrief/);
    assert.match(COUNCIL_CONTRACT, /noteValidDraft/);
    assert.match(COUNCIL_CONTRACT, /isPeerDraftDemoteError/);
  });
});
