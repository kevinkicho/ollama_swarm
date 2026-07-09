// Extracted from BlackboardRunner.ts — first-pass contract orchestration.
// Manages running the initial contract prompt, council-mode dispatch,
// resume-from-snapshot, and contract grounding/finalization.
// Takes a narrow ContractContext object instead of referencing `this.*`.

import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract } from "./types.js";
import type { PlannerSeed, PriorRunSummary } from "./prompts/planner.js";
import type { ParsedContract } from "./prompts/firstPassContract.js";
import type { CouncilContractDraft } from "./prompts/firstPassContract.js";
import {
  buildCouncilContractMergePrompt,
  buildFirstPassContractRepairPrompt,
  buildFirstPassContractUserPrompt,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
} from "./prompts/firstPassContract.js";
import { CONTRACT_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { groundExpectedFiles, validateContractGrounding } from "./contractGrounding.js";
import { withSiblingRetry } from "./siblingRetry.js";
import { config as appConfig } from "../../config.js";
import {
  readRecentMemory,
  renderMemoryForSeed,
} from "./memoryStore.js";
import {
  readDesignMemory,
  renderDesignMemoryForSeed,
} from "./designMemoryStore.js";
import {
  findAndReadNewestPriorSummary,
} from "../runSummary.js";
import { computeWorkerTagCounts } from "./BlackboardRunnerConstants.js";
import { gatherProposerContext } from "../moaContextGather.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import { runPlannerEmitRecovery } from "./plannerRecovery.js";
import { emitAgentActivity } from "./promptRunner.js";
import { isWebToolsEnabled, resolveToolProfile } from "../toolProfiles.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";
import type { TranscriptEntry } from "../../types.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { FindingsLog } from "./FindingsLog.js";
import type { TodoQueueCounts } from "./TodoQueue.js";
import {
  countActionableTodos,
  restoreBoardFromSnapshot,
} from "./boardRestore.js";
import {
  loadEndpointCatalogSnapshot,
  renderEndpointCatalogBlock,
} from "./endpointCatalogContext.js";

export interface ContractContext {
  // --- state getters ---
  getStopping: () => boolean;
  getActive: () => RunConfig | undefined;
  getContract: () => ExitContract | undefined;
  getPriorSnapshot: () => BlackboardStateSnapshot | null | undefined;
  getFindingsPost: () => (entry: { agentId: string; text: string; createdAt: number }) => void;
  getTodoQueue: () => TodoQueue;
  getFindingsLog: () => FindingsLog;
  getTodoQueueCounts: () => TodoQueueCounts;
  getBoardRestoredFromSnapshot: () => boolean;
  setBoardRestoredFromSnapshot: (v: boolean) => void;

  // --- state setters ---
  setContract: (c: ExitContract | undefined) => void;
  setCurrentTier: (t: number) => void;
  setTiersCompleted: (t: number) => void;
  setTierStartedAt: (t: number | undefined) => void;
  setTierHistory: (h: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
    wallClockMs: number;
    startedAt: number;
    endedAt: number;
  }>) => void;

  // --- callbacks ---
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
  getAuditor: () => Agent | undefined;
  emitAgentState: (s: import("../../types.js").AgentState) => void;
  manager: AgentManager;
  getPlannerFallbackModel: () => string | undefined;
  updateAgentModel: (agentId: string, model: string) => void;
  promptPlannerSafely: (
    primaryAgent: Agent,
    promptText: string,
    agentName?: import("../../tools/ToolDispatcher.js").ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: { kind?: string; label?: string },
  ) => Promise<{ response: string; agentUsed: Agent }>;
  promptAgent: (
    agent: Agent,
    prompt: string,
    agentName: import("../../tools/ToolDispatcher.js").ProfileName,
    formatExpect: "json" | "free",
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: { kind?: string; label?: string },
  ) => Promise<string>;
  emit: (e: unknown) => void;
  getTranscript: () => readonly TranscriptEntry[];
  getPlanner: () => Agent | undefined;
  directiveWithAmendments: () => string | undefined;
  getAmendments?: () => Array<{ ts: number; text: string }>;
  scheduleStateWrite: () => void;
  flushBoardBroadcasterSnapshot: () => void;
  v2ObserverApply: (event: unknown) => void;

  // --- deps ---
  repos: {
    listTopLevel: (clonePath: string) => Promise<string[]>;
    readReadme: (clonePath: string) => Promise<string | null>;
    listRepoFiles: (clonePath: string, opts: { maxFiles: number }) => Promise<string[]>;
  };
}

// --- Pure helpers ---

export function buildContract(parsed: ParsedContract): ExitContract {
  const addedAt = Date.now();
  return {
    missionStatement: parsed.missionStatement,
    criteria: parsed.criteria.map((c, i) => ({
      id: `c${i + 1}`,
      description: c.description,
      expectedFiles: [...c.expectedFiles],
      status: "unmet" as const,
      addedAt,
    })),
  };
}

export function cloneContract(c: ExitContract): ExitContract {
  return {
    missionStatement: c.missionStatement,
    criteria: c.criteria.map((crit) => ({
      ...crit,
      expectedFiles: [...crit.expectedFiles],
    })),
  };
}

// --- Async methods ---

export async function runFirstPassContract(
  ctx: ContractContext,
  agent: Agent,
  seed: PlannerSeed,
  isFallbackAttempt = false,
): Promise<void> {
  const modelAtEntry = agent.model;
  const exploreProfile = resolveToolProfile("planner", ctx.getActive());
  const emitProfile = "swarm-read" as import("../../tools/ToolDispatcher.js").ProfileName;

  const recovery = await runPlannerEmitRecovery({
    kind: "contract",
    agent,
    auditor: ctx.getAuditor(),
    getStopping: ctx.getStopping,
    appendSystem: ctx.appendSystem,
    appendAgent: ctx.appendAgent,
    findingsPost: ctx.findingsPost,
    getActive: ctx.getActive,
    emitActivity: (label, attempt, maxAttempts, mode) => {
      emitAgentActivity(agent, ctx.manager, ctx.emitAgentState, {
        kind: "contract",
        label,
        attempt,
        maxAttempts,
        mode,
      });
    },
    promptPlannerSafely: (a, p, profile, schema, activity) =>
      ctx.promptPlannerSafely(a, p, profile, schema, activity),
    buildExplorePrompt: () =>
      `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(seed, agent.model)}`,
    buildRepairPrompt: (prev, err, note) =>
      `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(prev, err, note)}`,
    exploreProfile,
    emitProfile,
    jsonSchema: CONTRACT_JSON_SCHEMA,
    parse: (raw) => {
      const p = parseFirstPassContractResponse(raw);
      if (!p.ok) return { ok: false as const, reason: p.reason, raw };
      const groundingError = validateContractGrounding(p.contract, seed.repoFiles);
      if (groundingError) return { ok: false as const, reason: groundingError, raw };
      return { ok: true as const, value: p.contract, raw, dropped: p.dropped };
    },
  });

  if (recovery.ok) {
    if (recovery.dropped.length > 0) {
      ctx.appendSystem(
        `Dropped ${recovery.dropped.length} invalid criterion(s): ${(recovery.dropped as Array<{ reason: string }>)
          .map((d) => d.reason)
          .join(" | ")}`,
      );
    }
    finalizeContract(ctx, recovery.value, seed, agent);
    return;
  }

  const retried = await withSiblingRetry(
    {
      agent,
      modelAtEntry,
      logPrefix: `[${agent.id}]`,
      updateAgentModel: ctx.updateAgentModel,
      emit: ctx.emit,
      getFallbackModel: ctx.getPlannerFallbackModel,
      reason: "sibling-retry: contract JSON parse failed after recovery loop",
      isFallbackAttempt,
    },
    async () => {
      await runFirstPassContract(ctx, agent, seed, true);
    },
  );
  if (retried) return;

  ctx.appendSystem(
    `Contract still invalid after recovery (${recovery.reason}). Planning continues WITHOUT exit contract — auditor will have limited gating.`,
  );
}

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
  const exploreProfile = resolveToolProfile("planner", deps.getActive());
  const emitProfile = "swarm-read" as import("../../tools/ToolDispatcher.js").ProfileName;
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
      { kind: "contract", label: "contract explore" },
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
  const councilEnabled =
    ctx.getActive()?.councilContract ?? appConfig.COUNCIL_CONTRACT_ENABLED;
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

  ctx.appendSystem(
    `Council contract: prompting ${allAgents.length} agents for independent first-pass drafts (explore → emit, with repo tools).`,
  );

  const { burstSpacingForModels, staggerStart } = await import("../staggerStart.js");
  let draftsCompleted = 0;
  const draftSpacing = burstSpacingForModels(allAgents);
  const draftResults = await staggerStart(allAgents, async (a) => {
    try {
      const result = await runCouncilContractDraftForAgent(draftDeps, a, seed);
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

export function finalizeContract(
  ctx: ContractContext,
  parsed: ParsedContract,
  seed: PlannerSeed,
  ownerAgent: Agent,
): void {
  let totalStripped = 0;
  let totalRebound = 0;
  const groundedCriteria = parsed.criteria.map((c, idx) => {
    const { grounded, stripped, rebound } = groundExpectedFiles(c.expectedFiles, seed.repoFiles);
    totalStripped += stripped.length;
    totalRebound += rebound.length;
    for (const rb of rebound) {
      ctx.getFindingsPost()({
        agentId: ownerAgent.id,
        text: `Contract c${idx + 1}: rebound '${rb.from}' → '${rb.to}' (similar in-repo sibling).`,
        createdAt: Date.now(),
      });
    }
    for (const r of stripped) {
      ctx.getFindingsPost()({
        agentId: ownerAgent.id,
        text: `Contract c${idx + 1}: stripped ungrounded path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    if (stripped.length > 0 || rebound.length > 0) {
      const parts: string[] = [];
      if (stripped.length > 0) {
        parts.push(`${stripped.length}/${c.expectedFiles.length} path(s) stripped`);
      }
      if (rebound.length > 0) {
        parts.push(`${rebound.length} rebound(s)`);
      }
      ctx.appendSystem(
        `Contract c${idx + 1}: ${parts.join("; ")} — expectedFiles=${JSON.stringify(grounded)}.`,
      );
    }
    return { description: c.description, expectedFiles: grounded };
  });
  if (totalStripped > 0 || totalRebound > 0) {
    ctx.appendSystem(
      `Contract grounding: ${totalStripped} path(s) stripped, ${totalRebound} rebound(s) across ${parsed.criteria.length} criteria.`,
    );
  }
  const groundedContract: ParsedContract = {
    missionStatement: parsed.missionStatement,
    criteria: groundedCriteria,
  };

  const contract = buildContract(groundedContract);
  ctx.setContract(contract);
  ctx.setCurrentTier(1);
  ctx.setTierStartedAt(Date.now());
  ctx.emit({ type: "contract_updated", contract: cloneContract(contract) });
  ctx.v2ObserverApply({
    type: "contract-built",
    ts: Date.now(),
    criteriaCount: contract.criteria.length,
  });
  ctx.scheduleStateWrite();

  if (contract.criteria.length === 0) {
    ctx.appendSystem(
      `Contract (tier 1): "${contract.missionStatement}" (0 criteria — planner found nothing to commit to).`,
    );
  } else {
    ctx.appendSystem(
      `Contract (tier 1): "${contract.missionStatement}" (${contract.criteria.length} criteria).`,
    );
  }
}

export async function tryResumeContract(ctx: ContractContext): Promise<boolean> {
  const snap = ctx.getPriorSnapshot();
  if (!snap || !snap.contract) {
    ctx.appendSystem(
      "Resume requested but no valid blackboard-state.json found — falling back to first-pass-contract.",
    );
    return false;
  }
  const contract = cloneContract(snap.contract);
  ctx.setContract(contract);
  ctx.setCurrentTier(snap.currentTier ?? 1);
  ctx.setTiersCompleted(snap.tiersCompleted ?? 0);
  ctx.setTierStartedAt(Date.now());
  if (snap.tierHistory && snap.tierHistory.length > 0) {
    ctx.setTierHistory(snap.tierHistory.map((t) => ({ ...t })));
  }

  const actionableBefore = countActionableTodos(snap.board?.todos ?? []);
  if (actionableBefore > 0 && snap.board?.todos?.length) {
    const restored = restoreBoardFromSnapshot({
      snap,
      todoQueue: ctx.getTodoQueue(),
      findings: ctx.getFindingsLog(),
    });
    ctx.setBoardRestoredFromSnapshot(true);
    ctx.appendSystem(
      `Resumed board from blackboard-state.json: ${restored.restoredTodos} todo(s) ` +
        `(${restored.pending} open, ${restored.pendingCommit} pending-commit, ` +
        `${restored.failed} stale, ${restored.skipped} skipped), ${restored.findings} finding(s). ` +
        `Claimed todos were re-queued as open.`,
    );
  } else {
    ctx.setBoardRestoredFromSnapshot(false);
  }

  ctx.emit({ type: "contract_updated", contract: cloneContract(contract) });
  ctx.scheduleStateWrite();
  if (ctx.getBoardRestoredFromSnapshot()) {
    ctx.flushBoardBroadcasterSnapshot();
  }
  let met = 0;
  let unmet = 0;
  let wontDo = 0;
  for (const c of contract.criteria) {
    if (c.status === "met") met++;
    else if (c.status === "wont-do") wontDo++;
    else unmet++;
  }
  ctx.appendSystem(
    `Resumed contract from blackboard-state.json (tier ${snap.currentTier ?? 1}, ${snap.tiersCompleted ?? 0} tiers completed prior). ` +
      `${met} met / ${unmet} unmet / ${wontDo} wont-do criteria carried over — ` +
      `auditor will re-evaluate against the current working tree.`,
  );
  return true;
}

export async function loadPriorRunSummary(
  clonePath: string,
): Promise<PriorRunSummary | undefined> {
  const summary = await findAndReadNewestPriorSummary(clonePath);
  if (!summary || !summary.contract || summary.contract.criteria.length === 0) {
    return undefined;
  }
  const startedAtIso = new Date(summary.startedAt).toISOString();
  return {
    startedAtIso,
    missionStatement: summary.contract.missionStatement,
    criteria: summary.contract.criteria.map((c) => ({
      id: c.id,
      description: c.description,
      status: c.status,
      rationale: c.rationale,
      expectedFiles: [...c.expectedFiles],
    })),
  };
}

export async function buildSeed(
  ctx: ContractContext,
  clonePath: string,
  cfg: RunConfig,
): Promise<PlannerSeed> {
  const topLevel = (await ctx.repos.listTopLevel(clonePath)).slice(0, 200);
  const readmeExcerpt = await ctx.repos.readReadme(clonePath);
  const repoFiles = await ctx.repos.listRepoFiles(clonePath, { maxFiles: 500 });
  const priorRunSummary = await loadPriorRunSummary(clonePath);

  let priorMemoryRendered: string | undefined;
  if (cfg.autoMemory !== false) {
    try {
      const recent = await readRecentMemory(clonePath);
      const rendered = renderMemoryForSeed(recent);
      priorMemoryRendered = rendered.length > 0 ? rendered : undefined;
      if (recent.length > 0 && cfg.suppressSeedMessages !== true) {
        ctx.appendSystem(
          `Memory: surfaced ${recent.length} prior-run lesson entry(ies) from .swarm-memory.jsonl into the planner seed.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Memory read failed (${msg}); continuing without prior-run context.`);
    }
  }

  let priorDesignMemoryRendered: string | undefined;
  if (cfg.autoDesignMemory !== false) {
    try {
      const dm = await readDesignMemory(clonePath);
      priorDesignMemoryRendered = renderDesignMemoryForSeed(dm);
      if (priorDesignMemoryRendered && cfg.suppressSeedMessages !== true) {
        const parts: string[] = [];
        if (dm.northStar) parts.push("north-star");
        if (dm.roadmap.length > 0) parts.push(`roadmap (${dm.roadmap.length})`);
        if (dm.decisions.length > 0) parts.push(`${dm.decisions.length} decision(s)`);
        ctx.appendSystem(
          `Design memory: surfaced ${parts.join(" + ")} from .swarm-design/ into the planner seed.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Design memory read failed (${msg}); continuing without long-horizon vision context.`);
    }
  }

  const workerTags = computeWorkerTagCounts(cfg.topology);

  let endpointCatalogBlock: string | undefined;
  try {
    const catalogSnap = await loadEndpointCatalogSnapshot(clonePath);
    if (catalogSnap) {
      endpointCatalogBlock = renderEndpointCatalogBlock(catalogSnap);
      if (cfg.suppressSeedMessages !== true) {
        ctx.appendSystem(
          `Endpoint grounding: surfaced ${catalogSnap.catalogPath ?? "no catalog"} + ` +
            `${catalogSnap.envKeys.length} env key(s) into planner/worker seed.`,
        );
      }
    }
  } catch {
    // best-effort — catalog read failure shouldn't block the run
  }

  const plannerAgent = ctx.getPlanner();
  const promptExtras = resolveBlackboardPromptExtras({
    active: cfg,
    getAmendments: ctx.getAmendments,
    transcript: ctx.getTranscript(),
    forAgentId: plannerAgent?.id ?? "agent-1",
  });
  const effectiveDirective = promptExtras.effectiveDirective;

  let codeContextExcerpts: ReadonlyArray<{ path: string; excerpt: string }> | undefined;
  try {
    const directive = (effectiveDirective ?? cfg.userDirective ?? "").trim();
    if (directive.length > 0 && repoFiles.length > 0) {
      const excerpts = await gatherProposerContext({
        clonePath,
        seed: `User directive: ${directive}`,
        repoFiles,
      });
      if (excerpts.length > 0) {
        codeContextExcerpts = excerpts;
      }
    }
  } catch {
    // best-effort — gather failure shouldn't block the planner
  }

  // Ambitious idea: simple system map for broad understanding (Context Oracle / system map)
  const systemMap = `System overview for ${(effectiveDirective ?? cfg.userDirective) || "the project"}:
- Top level dirs: ${topLevel.slice(0,5).join(', ')}
- Key files (sample): ${repoFiles.slice(0,10).join(', ')}
- README summary: ${readmeExcerpt ? readmeExcerpt.slice(0,200) : 'N/A'}
This is a lightweight map to help with systemic planning without full repo dump.`;

  let projectGraphSlice: string | undefined;
  try {
    const { getProjectGraphSliceForClone } = await import("../../projectGraph/service.js");
    const { DEFAULT_PLANNER_SLICE_MAX_CHARS } = await import("../../projectGraph/formatAgentSlice.js");
    projectGraphSlice = await getProjectGraphSliceForClone(clonePath, cfg, {
      maxChars: DEFAULT_PLANNER_SLICE_MAX_CHARS,
    });
    if (projectGraphSlice && cfg.suppressSeedMessages !== true) {
      ctx.appendSystem("Project map: surfaced cross-run knowledge graph into planner seed.");
    }
  } catch {
    // best-effort
  }

  return {
    repoUrl: cfg.repoUrl,
    clonePath,
    topLevel,
    repoFiles,
    readmeExcerpt,
    userDirective: effectiveDirective ?? cfg.userDirective,
    ...(promptExtras.userChatBlock ? { userChatBlock: promptExtras.userChatBlock } : {}),
    priorRunSummary,
    priorMemoryRendered,
    priorDesignMemoryRendered,
    workerTags,
    ...(codeContextExcerpts ? { codeContextExcerpts } : {}),
    ...(cfg.testDrivenTodos ? { testDrivenTodos: true } : {}),
    ...(cfg.parallelHypothesis ? { parallelHypothesis: true } : {}),
    systemMap,  // for planner to use for broad view
    webToolsEnabled: isWebToolsEnabled(cfg),
    ...(endpointCatalogBlock ? { endpointCatalogBlock } : {}),
    ...(projectGraphSlice ? { projectGraphSlice } : {}),
  };
}
