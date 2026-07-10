// Council contract draft/merge path — extracted from contractBuilder.ts.

import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import type { ParsedContract } from "./prompts/firstPassContract.js";
import type { CouncilContractDraft } from "./prompts/firstPassContract.js";
import {
  buildCouncilContractEmitUserPrompt,
  buildCouncilContractMergePrompt,
  buildFirstPassContractRepairPrompt,
  buildFirstPassContractUserPrompt,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
} from "./prompts/firstPassContract.js";
import { captureExplorationExcerpt } from "@ollama-swarm/shared/explorationCache";
import { CONTRACT_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { validateContractGrounding } from "./contractGrounding.js";
import { config as appConfig } from "../../config.js";
import { emitAgentActivity } from "./promptRunner.js";
import { EMIT_ONLY_PROFILE_ID } from "@ollama-swarm/shared/toolProfiles";
import { resolveToolProfile } from "../toolProfiles.js";
import { resolveMaxToolTurnsForPlanningPhase } from "@ollama-swarm/shared/toolProfiles";
import {
  buildScopedUiContract,
  inferScopedUiExpectedFiles,
  resolveContractExploreProfile,
  shouldSkipContractDerivation,
} from "./planningPolicy.js";
import { isSeedSufficientForDirectEmit } from "@ollama-swarm/shared/planningSeed";
import { buildSeedDirectEmitBrief } from "./prompts/plannerGrounding.js";
import type { ContractContext } from "./contractBuilder.js";
import {
  finalizeContract,
  runFirstPassContract,
  recordExploreOnSeed,
} from "./contractBuilder.js";

/** Narrow deps for council per-agent contract drafts (blackboard + CouncilRunner). */
export interface CouncilContractDraftDeps {
  getStopping: () => boolean;
  getActive: () => RunConfig | undefined;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  manager: AgentManager;
  emitAgentState: (s: import("../../types.js").AgentState) => void;
  promptPlannerSafely: ContractContext["promptPlannerSafely"];
}

/** Single lead explore for council — shared brief feeds N emit-only drafts. */
export async function runCouncilSharedExplore(
  deps: CouncilContractDraftDeps,
  leadAgent: Agent,
  seed: PlannerSeed,
): Promise<string | null> {
  const exploreProfile = resolveContractExploreProfile(seed, deps.getActive());
  const exploreToolCap = resolveMaxToolTurnsForPlanningPhase(
    "contract-explore",
    deps.getActive(),
  );
  const explorePrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(
    seed,
    leadAgent.model,
  )}`;

  emitAgentActivity(leadAgent, deps.manager, deps.emitAgentState, {
    kind: "contract",
    label: "council shared explore",
    attempt: 1,
    maxAttempts: 1,
    mode: "explore",
  });
  deps.appendSystem(
    `Council contract: Agent ${leadAgent.index} exploring repo once for shared brief…`,
  );

  const { response, agentUsed } = await deps.promptPlannerSafely(
    leadAgent,
    explorePrompt,
    exploreProfile,
    undefined,
    { kind: "contract", label: "council shared explore", maxToolTurns: exploreToolCap, mode: "explore" },
  );
  if (deps.getStopping()) return null;
  deps.appendAgent(agentUsed, response);
  recordExploreOnSeed(seed, "council-shared-explore", response, agentUsed.id);
  return captureExplorationExcerpt(response);
}

/** Emit-only council draft using a shared explore brief (no per-agent repo tour). */
export async function runCouncilContractEmitForAgent(
  deps: CouncilContractDraftDeps,
  agent: Agent,
  seed: PlannerSeed,
  sharedExploreBrief: string,
): Promise<{ agent: Agent; text: string } | null> {
  const emitProfile = EMIT_ONLY_PROFILE_ID;
  const emitPrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildCouncilContractEmitUserPrompt(
    seed,
    sharedExploreBrief,
    agent.model,
  )}`;

  emitAgentActivity(agent, deps.manager, deps.emitAgentState, {
    kind: "contract",
    label: "contract draft (emit)",
    attempt: 1,
    maxAttempts: 1,
    mode: "emit",
  });

  const { response, agentUsed } = await deps.promptPlannerSafely(
    agent,
    emitPrompt,
    emitProfile,
    CONTRACT_JSON_SCHEMA,
    { kind: "contract", label: "contract draft (emit)" },
  );
  if (deps.getStopping()) return null;
  deps.appendAgent(agentUsed, response);
  return { agent: agentUsed, text: response };
}

/**
 * Two-phase council draft: explore the clone with repo tools, then emit JSON.
 * Mirrors the single-agent `runPlannerEmitRecovery` explore→emit split so drafts
 * are grounded in actual file reads, not filename pattern-matching.
 */
export async function runCouncilContractDraftForAgent(
  deps: CouncilContractDraftDeps,
  agent: Agent,
  seed: PlannerSeed,
): Promise<{ agent: Agent; text: string } | null> {
  const seedDirectEmit = isSeedSufficientForDirectEmit(seed, deps.getActive());
  if (seedDirectEmit) {
    return runCouncilContractEmitForAgent(
      deps,
      agent,
      seed,
      buildSeedDirectEmitBrief(seed),
    );
  }

  const exploreProfile = resolveContractExploreProfile(seed, deps.getActive());
  const emitProfile = EMIT_ONLY_PROFILE_ID;
  const exploreToolCap = resolveMaxToolTurnsForPlanningPhase(
    "contract-explore",
    deps.getActive(),
  );
  const explorePrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(
    seed,
    agent.model,
  )}`;

  emitAgentActivity(agent, deps.manager, deps.emitAgentState, {
    kind: "contract",
    label: "contract explore",
    attempt: 1,
    maxAttempts: 2,
    mode: "explore",
  });
  deps.appendSystem(
    `Council contract: Agent ${agent.index} exploring repo before draft…`,
  );

  const { response: exploreResponse, agentUsed: exploreAgent } =
    await deps.promptPlannerSafely(
      agent,
      explorePrompt,
      exploreProfile,
      undefined,
      { kind: "contract", label: "contract explore", maxToolTurns: exploreToolCap, mode: "explore" },
    );
  if (deps.getStopping()) return null;
  deps.appendAgent(exploreAgent, exploreResponse);

  const parsedExplore = parseFirstPassContractResponse(exploreResponse);
  const exploreGroundingError = parsedExplore.ok
    ? validateContractGrounding(parsedExplore.contract, seed.repoFiles)
    : undefined;
  if (parsedExplore.ok && !exploreGroundingError) {
    deps.appendSystem(
      `Council contract: Agent ${exploreAgent.index} draft parsed from explore — skipping redundant emit.`,
    );
    return { agent: exploreAgent, text: exploreResponse };
  }

  const emitRepairReason = parsedExplore.ok
    ? (exploreGroundingError ?? "grounding failed")
    : parsedExplore.reason;

  emitAgentActivity(exploreAgent, deps.manager, deps.emitAgentState, {
    kind: "contract",
    label: "contract draft",
    attempt: 2,
    maxAttempts: 2,
    mode: "emit",
  });
  deps.appendSystem(
    `Council contract: Agent ${exploreAgent.index} emitting contract JSON…`,
  );

  const emitPrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
    exploreResponse,
    emitRepairReason,
  )}`;
  const { response: emitResponse, agentUsed: emitAgent } =
    await deps.promptPlannerSafely(
      exploreAgent,
      emitPrompt,
      emitProfile,
      CONTRACT_JSON_SCHEMA,
      { kind: "contract", label: "contract draft" },
    );
  if (deps.getStopping()) return null;
  deps.appendAgent(emitAgent, emitResponse);
  return { agent: emitAgent, text: emitResponse };
}

export async function runFirstPassContractOrchestrator(
  ctx: ContractContext,
  planner: Agent,
  workers: Agent[],
  seed: PlannerSeed,
): Promise<void> {
  const active = ctx.getActive();
  if (shouldSkipContractDerivation(active, seed)) {
    const directive = (seed.userDirective ?? active?.userDirective ?? "").trim();
    const files = inferScopedUiExpectedFiles(seed, directive);
    const synthetic = buildScopedUiContract(directive, files);
    ctx.appendSystem(
      "Contract fast path: scoped UI directive — synthetic contract from seed (skipped LLM derivation).",
    );
    finalizeContract(ctx, synthetic, seed, planner);
    return;
  }

  const councilEnabled =
    active?.councilContract ?? appConfig.COUNCIL_CONTRACT_ENABLED;
  if (councilEnabled && workers.length > 0) {
    const merged = await tryCouncilContract(ctx, planner, workers, seed);
    if (merged !== null) {
      finalizeContract(ctx, merged, seed, planner);
      return;
    }
    ctx.appendSystem(
      "Council contract produced no usable drafts or merge failed; falling back to single-agent contract.",
    );
  }
  await runFirstPassContract(ctx, planner, seed);
}

export async function tryCouncilContract(
  ctx: ContractContext,
  planner: Agent,
  workers: Agent[],
  seed: PlannerSeed,
): Promise<ParsedContract | null> {
  const allAgents = [planner, ...workers];
  const draftDeps: CouncilContractDraftDeps = {
    getStopping: ctx.getStopping,
    getActive: ctx.getActive,
    appendSystem: ctx.appendSystem,
    appendAgent: ctx.appendAgent,
    manager: ctx.manager,
    emitAgentState: ctx.emitAgentState,
    promptPlannerSafely: (
      agent,
      promptText,
      agentName,
      ollamaFormat,
      activity,
    ) => ctx.promptPlannerSafely(agent, promptText, agentName, ollamaFormat, activity),
  };

  const useSharedExplore =
    allAgents.length > 1
    && (ctx.getActive()?.councilSharedExplore ?? true);

  const seedDirectEmit = isSeedSufficientForDirectEmit(seed, ctx.getActive());
  let sharedBrief: string | null = null;
  if (useSharedExplore) {
    if (seedDirectEmit) {
      sharedBrief = buildSeedDirectEmitBrief(seed);
      ctx.appendSystem(
        "Council contract: seed-direct emit — skipping shared explore.",
      );
    } else {
      sharedBrief = await runCouncilSharedExplore(draftDeps, planner, seed);
      if (ctx.getStopping()) return null;
    }
  }

  if (useSharedExplore && sharedBrief) {
    ctx.appendSystem(
      `Council contract: shared explore complete — ${allAgents.length} emit-only draft(s) from brief.`,
    );
  } else {
    ctx.appendSystem(
      `Council contract: prompting ${allAgents.length} agents for independent first-pass drafts (explore → emit, with repo tools).`,
    );
  }

  const { burstSpacingForModels, staggerStart } = await import("../staggerStart.js");
  let draftsCompleted = 0;
  const draftSpacing = burstSpacingForModels(allAgents);
  const draftResults = await staggerStart(allAgents, async (a) => {
    try {
      const result =
        useSharedExplore && sharedBrief
          ? await runCouncilContractEmitForAgent(draftDeps, a, seed, sharedBrief)
          : await runCouncilContractDraftForAgent(draftDeps, a, seed);
      if (!result) return null;
      return result;
    } finally {
      draftsCompleted++;
      if (draftsCompleted < allAgents.length) {
        ctx.appendSystem(
          `Council contract: ${draftsCompleted}/${allAgents.length} drafts complete — waiting on remaining agent(s).`,
        );
      }
    }
  }, draftSpacing);

  const drafts: CouncilContractDraft[] = [];
  for (let i = 0; i < draftResults.length; i++) {
    const r = draftResults[i]!;
    const agent = allAgents[i]!;
    if (r.status !== "fulfilled") {
      ctx.appendSystem(
        `Council draft from ${agent.id} rejected: ${
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        }`,
      );
      continue;
    }
    if (!r.value) continue;
    const parsed = parseFirstPassContractResponse(r.value.text);
    if (!parsed.ok) {
      ctx.appendSystem(
        `Council draft from ${r.value.agent.id} did not parse (${parsed.reason}); skipping.`,
      );
      continue;
    }
    if (parsed.dropped.length > 0) {
      ctx.appendSystem(
        `Council draft from ${r.value.agent.id}: dropped ${parsed.dropped.length} invalid criterion(s) at parse time.`,
      );
    }
    drafts.push({ agentId: r.value.agent.id, contract: parsed.contract });
  }

  if (drafts.length === 0) {
    ctx.appendSystem("Council contract: 0 drafts survived parsing.");
    return null;
  }
  if (drafts.length === 1) {
    ctx.appendSystem(
      `Council contract: only 1 of ${allAgents.length} drafts parsed — using it directly (no merge).`,
    );
    return drafts[0].contract;
  }

  ctx.appendSystem(
    `Council contract: ${drafts.length} drafts parsed; running merge via planner.`,
  );
  const mergePrompt = buildCouncilContractMergePrompt(seed, drafts);
  const plannerProfile = resolveToolProfile("planner", ctx.getActive());
  const { response: mergeResponse, agentUsed: mergeAgent } =
    await ctx.promptPlannerSafely(planner, mergePrompt, plannerProfile, CONTRACT_JSON_SCHEMA);
  if (ctx.getStopping()) return null;
  ctx.appendAgent(mergeAgent, mergeResponse);

  let mergeParsed = parseFirstPassContractResponse(mergeResponse);
  if (!mergeParsed.ok) {
    ctx.appendSystem(
      `Council merge response did not parse (${mergeParsed.reason}). Issuing repair prompt.`,
    );
    const { response: repairResponse, agentUsed: repairAgent } =
      await ctx.promptPlannerSafely(
        mergeAgent,
        `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
          mergeResponse,
          mergeParsed.reason,
        )}`,
        plannerProfile,
        CONTRACT_JSON_SCHEMA,
      );
    if (ctx.getStopping()) return null;
    ctx.appendAgent(repairAgent, repairResponse);
    mergeParsed = parseFirstPassContractResponse(repairResponse);
    if (!mergeParsed.ok) {
      ctx.appendSystem(
        `Council merge still invalid after repair (${mergeParsed.reason}). Using best draft (most criteria) as fallback.`,
      );
      const best = drafts.reduce((a, b) =>
        b.contract.criteria.length > a.contract.criteria.length ? b : a,
      );
      return best.contract;
    }
  }
  if (mergeParsed.dropped.length > 0) {
    ctx.appendSystem(
      `Council merge: dropped ${mergeParsed.dropped.length} invalid criterion(s) at parse time.`,
    );
  }
  return mergeParsed.contract;
}

