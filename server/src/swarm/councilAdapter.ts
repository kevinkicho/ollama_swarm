import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { ExitContract, ExitCriterion, Todo as BoardTodo } from "./blackboard/types.js";
import { TodoQueue, type PostTodoInput } from "./blackboard/TodoQueue.js";
import { FindingsLog } from "./blackboard/FindingsLog.js";
import { groundExpectedFiles } from "./blackboard/contractGrounding.js";
import { parseFirstPassContractResponse } from "./blackboard/prompts/firstPassContract.js";
import {
  buildContract,
  buildSeed,
  runCouncilContractDraftForAgent,
  runCouncilContractEmitForAgent,
  runCouncilSharedExplore,
  type ContractContext,
  type CouncilContractDraftDeps,
} from "./blackboard/contractBuilder.js";
import { isSeedSufficientForDirectEmit } from "@ollama-swarm/shared/planningSeed";
import { buildSeedDirectEmitBrief } from "./blackboard/prompts/plannerGrounding.js";
import type { TranscriptEntry } from "../types.js";
import type { PlannerSeed } from "./blackboard/prompts/planner.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { canonicalizeExpectedFiles } from "./councilPathCanonicalize.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText, createTimeoutController } from "./councilUtils.js";
import { burstSpacingForModels, staggerStart } from "./staggerStart.js";
import { makeBufferedToolHandler, type ToolTraceEntry } from "./toolCallTranscript.js";
import { resolveCouncilToolProfile } from "./toolProfiles.js";

/** Wall-clock cap per contract draft. Covers provider cold-start (p95
 *  can exceed 90s on :cloud) without blocking the whole batch forever. */
const CONTRACT_DRAFT_TIMEOUT_MS = 180_000;


export interface CouncilAdapterState {
  cfg: RunConfig;
  clonePath: string;
  stopping: boolean;
  todoQueue: TodoQueue;
  findings: FindingsLog;
  contract: ExitContract | undefined;
  currentTier: number;
  tiersCompleted: number;
  tierHistory: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
    wallClockMs: number;
    startedAt: number;
    endedAt: number;
  }>;
  tierStartedAt: number | undefined;
  auditInvocations: number;
  committedFiles: string[];
  /** Neutral shared progress text injected into agent prompts (optional). */
  progressContext?: string;
  runStartedAt: number | undefined;
  manager: {
    list: () => Agent[];
    markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void;
    recordPromptComplete: (id: string, data: any) => void;
  };
  repos: { listTopLevel: (p: string) => Promise<string[]>; readReadme: (p: string) => Promise<string | null>; listRepoFiles: (p: string, opts: { maxFiles: number }) => Promise<string[]> };
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    opts?: { role?: "worker" | "general" },
  ) => void;
  emit: (e: unknown) => void;
  logDiag: (entry: Record<string, unknown>) => void;
  /** Shared with CouncilRunner — tool invocations attach to the next appendAgent bubble. */
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;
  /** Mid-run HITL amendments (orchestrator AmendmentsBuffer). */
  getAmendments?: () => Array<{ ts: number; text: string }>;
  /**
   * Run-level literature/web research blackout (eee6718f RCA).
   * After consecutive literature pre-pass failures, skip further web research
   * for the rest of the run so workers spend tokens on hunks, not 403 thrash.
   */
  researchBlackout?: {
    consecutiveFailures: number;
    active: boolean;
    lastReason?: string;
  };
  /** RR-D: consecutive empty standup/execution cycles. */
  emptyExecutionStreak?: number;
  /** Per-todo literature notes cache — avoid re-running research on repair/failover. */
  literatureNotesByTodoId?: Map<string, string | null>;
}

export function buildCouncilAdapterState(
  cfg: RunConfig,
  clonePath: string,
  manager: CouncilAdapterState["manager"],
  repos: { listTopLevel: (p: string) => Promise<string[]>; readReadme: (p: string) => Promise<string | null>; listRepoFiles: (p: string, opts: { maxFiles: number }) => Promise<string[]> },
  appendSystem: (msg: string) => void,
  appendAgent: (
    agent: Agent,
    text: string,
    opts?: { role?: "worker" | "general" },
  ) => void,
  emit: (e: unknown) => void,
  logDiag: (entry: Record<string, unknown>) => void,
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>,
  getAmendments?: () => Array<{ ts: number; text: string }>,
): CouncilAdapterState {
  return {
    cfg,
    clonePath,
    stopping: false,
    todoQueue: new TodoQueue(),
    findings: new FindingsLog(),
    contract: undefined,
    currentTier: 1,
    tiersCompleted: 0,
    tierHistory: [],
    tierStartedAt: undefined,
    auditInvocations: 0,
    committedFiles: [],
    runStartedAt: undefined,
    manager,
    repos,
    getAmendments,
    appendSystem,
    appendAgent,
    emit,
    logDiag,
    pendingToolTraceByAgent,
    researchBlackout: { consecutiveFailures: 0, active: false },
    literatureNotesByTodoId: new Map(),
  };
}

export async function promptAgent(
  agent: Agent,
  prompt: string,
  agentName: import("../tools/ToolDispatcher.js").ProfileName,
  formatExpect: "json" | "free",
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void },
  providerFailover?: readonly string[],
  signal?: AbortSignal,
  activity?: { kind?: string; label?: string },
  pendingToolTraceByAgent?: Map<string, ToolTraceEntry[]>,
): Promise<string> {
  const raw = await promptWithFailoverAuto(agent, prompt, {
    manager: manager as any,
    agentName,
    formatExpect,
    signal: signal ?? new AbortController().signal,
    ...(activity ? { activity: { kind: activity.kind ?? "council", label: activity.label } } : {}),
    ...(pendingToolTraceByAgent
      ? { onTool: makeBufferedToolHandler(pendingToolTraceByAgent, agent.id) }
      : {}),
  }, providerFailover);
  const text = extractProviderText(raw);
  return text ?? "";
}

export type CouncilPromptActivity = {
  kind?: string;
  label?: string;
  maxToolTurns?: number;
  mode?: "explore" | "emit";
};

/**
 * Council planner/contract prompts. Must forward maxToolTurns + toolLoopNudge
 * (run d3f56d9a: activity.maxToolTurns was dropped → full profile 20-turn thrash).
 */
export async function promptPlannerSafely(
  agent: Agent,
  promptText: string,
  agentName: import("../tools/ToolDispatcher.js").ProfileName | undefined,
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void },
  providerFailover?: readonly string[],
  activity?: CouncilPromptActivity,
  signal?: AbortSignal,
  pendingToolTraceByAgent?: Map<string, ToolTraceEntry[]>,
  toolProfileCfg?: unknown,
  ollamaFormat?: "json" | Record<string, unknown>,
  toolLoopNudge?: { atTurn: number; message: string },
): Promise<{ response: string; agentUsed: Agent }> {
  const { contractExploreJsonNudge } = await import("@ollama-swarm/shared/toolProfiles");
  const nudge =
    toolLoopNudge
    ?? (activity?.kind === "contract" && activity.mode === "explore"
      ? contractExploreJsonNudge()
      : undefined);

  const raw = await promptWithFailoverAuto(agent, promptText, {
    manager: manager as any,
    agentName: agentName ?? resolveCouncilToolProfile(toolProfileCfg),
    formatExpect: "json",
    signal: signal ?? new AbortController().signal,
    ...(activity
      ? {
          activity: {
            kind: activity.kind ?? "council",
            label: activity.label,
            ...(activity.mode ? { mode: activity.mode } : {}),
          },
        }
      : {}),
    ...(activity?.maxToolTurns !== undefined ? { maxToolTurns: activity.maxToolTurns } : {}),
    ...(nudge ? { toolLoopNudge: nudge } : {}),
    ...(ollamaFormat !== undefined ? { ollamaFormat } : {}),
    ...(pendingToolTraceByAgent
      ? { onTool: makeBufferedToolHandler(pendingToolTraceByAgent, agent.id) }
      : {}),
  }, providerFailover);
  const text = extractProviderText(raw);
  return { response: text ?? "", agentUsed: agent };
}
/** Minimal ContractContext for council paths that call shared buildSeed(). */
function councilBuildSeedContext(
  state: CouncilAdapterState,
  planner: Agent | undefined,
  getTranscript: () => readonly TranscriptEntry[] = () => [],
): ContractContext {
  return {
    manager: state.manager as ContractContext["manager"],
    getStopping: () => state.stopping,
    getActive: () => state.cfg,
    getContract: () => state.contract,
    getPriorSnapshot: () => null,
    getFindingsPost: () => (entry: { agentId: string; text: string; createdAt: number }) => {
      state.findings.post(entry);
    },
    getTodoQueue: () => state.todoQueue,
    getFindingsLog: () => state.findings,
    getTodoQueueCounts: () => state.todoQueue.counts(),
    getBoardRestoredFromSnapshot: () => false,
    setBoardRestoredFromSnapshot: () => {},
    setContract: (c) => { state.contract = c; },
    setCurrentTier: (t) => { state.currentTier = t; },
    setTiersCompleted: (t) => { state.tiersCompleted = t; },
    setTierStartedAt: (t) => { state.tierStartedAt = t; },
    setTierHistory: (h) => { state.tierHistory = h; },
    appendSystem: state.appendSystem,
    appendAgent: state.appendAgent,
    findingsPost: (entry) => { state.findings.post(entry); },
    getAuditor: () => undefined,
    emitAgentState: () => {},
    getPlannerFallbackModel: () => undefined,
    updateAgentModel: () => {},
    promptPlannerSafely: (agent, promptText, agentName, ollamaFormat, activity) =>
      promptPlannerSafely(
        agent,
        promptText,
        agentName,
        state.manager,
        state.cfg.providerFailover,
        activity,
        undefined,
        state.pendingToolTraceByAgent,
        state.cfg,
        ollamaFormat,
      ),
    promptAgent: (agent, prompt, agentName, formatExpect) =>
      promptAgent(
        agent,
        prompt,
        agentName,
        formatExpect,
        state.manager,
        state.cfg.providerFailover,
        undefined,
        undefined,
        state.pendingToolTraceByAgent,
      ),
    emit: state.emit,
    getTranscript,
    getPlanner: () => planner,
    directiveWithAmendments: () => {
      const base = state.cfg.userDirective?.trim() ?? "";
      const amendments = state.getAmendments?.() ?? [];
      if (amendments.length === 0) return base.length > 0 ? base : undefined;
      const nudges = amendments
        .map((a, i) => `[user nudge #${i + 1}] ${a.text.trim()}`)
        .filter((l) => l.length > 0)
        .join("\n");
      const header =
        "MID-RUN USER NUDGES (treat as additions to the directive):";
      return base.length > 0 ? `${base}\n\n${header}\n${nudges}` : `${header}\n${nudges}`;
    },
    scheduleStateWrite: () => {},
    flushBoardBroadcasterSnapshot: () => {},
    v2ObserverApply: () => {},
    repos: state.repos,
  };
}

export async function runContractDerivation(
  state: CouncilAdapterState,
  planner: Agent,
  workers: Agent[],
  getTranscript: () => readonly TranscriptEntry[] = () => [],
): Promise<void> {
  const seed = await buildSeed(
    councilBuildSeedContext(state, planner, getTranscript),
    state.clonePath,
    state.cfg,
  );

  // Run council-style contract (all agents propose, lead merges)
  const allAgents = [planner, ...workers];
  const mergePlanner = planner;
  if (!mergePlanner) {
    state.appendSystem("Council contract: no LLM lead agent — proceeding without contract.");
    return;
  }
  let draftAbort: AbortSignal | undefined;
  const draftDeps: CouncilContractDraftDeps = {
    getStopping: () => state.stopping,
    getActive: () => state.cfg,
    appendSystem: state.appendSystem,
    appendAgent: state.appendAgent,
    manager: state.manager as import("../services/AgentManager.js").AgentManager,
    emitAgentState: (s) => state.emit({ type: "agent_state", agent: s }),
    promptPlannerSafely: (agent, promptText, agentName, ollamaFormat, activity) =>
      promptPlannerSafely(
        agent,
        promptText,
        agentName,
        state.manager,
        state.cfg.providerFailover,
        activity,
        draftAbort,
        state.pendingToolTraceByAgent,
        state.cfg,
        ollamaFormat,
      ),
  };

  // Multi-agent: shared explore → N emit-only drafts by default (d3f56d9a:
  // independent explore burned 20-tool loops × fat seed). Opt out with
  // councilSharedExplore: false.
  const useSharedExplore =
    allAgents.length > 1
    && state.cfg.councilSharedExplore !== false;
  const seedDirectEmit = isSeedSufficientForDirectEmit(seed, state.cfg);
  let sharedBrief: string | null = null;
  if (useSharedExplore) {
    if (seedDirectEmit) {
      sharedBrief = buildSeedDirectEmitBrief(seed);
      state.appendSystem(
        "Council contract: seed-direct emit — skipping shared explore.",
      );
    } else {
      const { controller: exploreAbort, cleanup: exploreCleanup } =
        createTimeoutController(CONTRACT_DRAFT_TIMEOUT_MS);
      draftAbort = exploreAbort.signal;
      try {
        sharedBrief = await runCouncilSharedExplore(draftDeps, mergePlanner, seed);
      } finally {
        exploreCleanup();
        draftAbort = undefined;
      }
      if (state.stopping) return;
    }
  }

  if (useSharedExplore && sharedBrief) {
    state.appendSystem(
      `Council contract: shared explore complete — ${allAgents.length} emit-only draft(s) from brief.`,
    );
  } else {
    state.appendSystem(
      `Council contract: prompting ${allAgents.length} agents for independent first-pass drafts (explore → emit, with repo tools).`,
    );
  }

  let draftsCompleted = 0;
  const draftSpacing = burstSpacingForModels(allAgents);
  const draftResults = await staggerStart(allAgents, async (a) => {
    const { controller, cleanup } = createTimeoutController(CONTRACT_DRAFT_TIMEOUT_MS);
    draftAbort = controller.signal;
    try {
      return useSharedExplore && sharedBrief
        ? await runCouncilContractEmitForAgent(draftDeps, a, seed, sharedBrief)
        : await runCouncilContractDraftForAgent(draftDeps, a, seed);
    } finally {
      cleanup();
      draftAbort = undefined;
      state.manager.markStatus(a.id, "ready");
      draftsCompleted++;
      if (draftsCompleted < allAgents.length) {
        state.appendSystem(
          `Council contract: ${draftsCompleted}/${allAgents.length} drafts complete — waiting on remaining agent(s).`,
        );
      }
    }
  }, draftSpacing);

  const drafts: Array<{ agentId: string; contract: any }> = [];
  const failedDraftAgentIds = new Set<string>();
  for (let i = 0; i < draftResults.length; i++) {
    const r = draftResults[i]!;
    const agent = allAgents[i]!;
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      state.appendSystem(`Council draft from ${agent.id} failed (${msg}).`);
      failedDraftAgentIds.add(agent.id);
      // Contract-phase tool thrash must land in cycleIntegrity (d3f56d9a).
      try {
        const { recordCycleFail } = await import("./cycleIntegrityStats.js");
        recordCycleFail(msg, state.cfg.runId, agent.id);
      } catch {
        /* best-effort */
      }
      continue;
    }
    if (!r.value) {
      failedDraftAgentIds.add(agent.id);
      continue;
    }
    const parsed = parseFirstPassContractResponse(r.value.text);
    if (!parsed.ok) {
      failedDraftAgentIds.add(r.value.agent.id);
      continue;
    }
    if (parsed.dropped.length > 0) {
      state.appendSystem(
        `Council draft from ${r.value.agent.id}: dropped ${parsed.dropped.length} invalid criterion(s).`,
      );
    }
    drafts.push({ agentId: r.value.agent.id, contract: parsed.contract });
  }

  if (drafts.length === 0) {
    state.appendSystem("Council contract: 0 drafts survived parsing — proceeding without contract.");
    return;
  }

  if (drafts.length === 1) {
    const owner =
      allAgents.find((a) => a.id === drafts[0]!.agentId) ?? mergePlanner;
    finalizeContract(state, drafts[0]!.contract, seed, owner);
    return;
  }

  // Merge: emit-only JSON synthesis — never re-open full explore (d3f56d9a
  // merge continued tool-looping after explore failure). Prefer an agent that
  // already produced a valid draft, not the tool-loop loser.
  const { buildCouncilContractMergePrompt } = await import("./blackboard/prompts/firstPassContract.js");
  const { CONTRACT_JSON_SCHEMA } = await import("./blackboard/prompts/jsonSchemas.js");
  const { EMIT_ONLY_PROFILE_ID, CONTRACT_MERGE_MAX_TOOL_TURNS } = await import(
    "@ollama-swarm/shared/toolProfiles"
  );
  const mergePrompt = buildCouncilContractMergePrompt(seed, drafts);
  const mergeAgentPick =
    allAgents.find(
      (a) => drafts.some((d) => d.agentId === a.id) && !failedDraftAgentIds.has(a.id),
    )
    ?? allAgents.find((a) => !failedDraftAgentIds.has(a.id))
    ?? mergePlanner;

  state.appendSystem(
    `Council contract: merging ${drafts.length} drafts via ${mergeAgentPick.id} (emit-only)…`,
  );
  state.manager.markStatus(mergeAgentPick.id, "thinking", {
    activityKind: "contract",
    activityLabel: "contract merge",
  });
  let mergeResponse: string;
  let mergeAgent: Agent;
  const { controller: mergeAbort, cleanup: mergeCleanup } = createTimeoutController(CONTRACT_DRAFT_TIMEOUT_MS);
  try {
    ({ response: mergeResponse, agentUsed: mergeAgent } = await promptPlannerSafely(
      mergeAgentPick,
      mergePrompt,
      EMIT_ONLY_PROFILE_ID,
      state.manager,
      state.cfg.providerFailover,
      {
        kind: "contract",
        label: "contract merge",
        maxToolTurns: CONTRACT_MERGE_MAX_TOOL_TURNS,
        mode: "emit",
      },
      mergeAbort.signal,
      state.pendingToolTraceByAgent,
      state.cfg,
      CONTRACT_JSON_SCHEMA,
    ));
  } finally {
    mergeCleanup();
    state.manager.markStatus(mergeAgentPick.id, "ready");
  }  if (state.stopping) return;
  state.appendAgent(mergeAgent, mergeResponse);

  let mergeParsed = parseFirstPassContractResponse(mergeResponse);
  if (!mergeParsed.ok) {
    state.appendSystem(`Council merge did not parse (${mergeParsed.reason}). Using best draft.`);
    const best = drafts.reduce((a, b) =>
      b.contract.criteria.length > a.contract.criteria.length ? b : a,
    );
    finalizeContract(state, best.contract, seed, mergePlanner);
    return;
  }
  if (mergeParsed.dropped.length > 0) {
    state.appendSystem(`Council merge: dropped ${mergeParsed.dropped.length} invalid criterion(s).`);
  }
  finalizeContract(state, mergeParsed.contract, seed, mergePlanner);
}

function finalizeContract(
  state: CouncilAdapterState,
  parsed: { missionStatement: string; criteria: Array<{ description: string; expectedFiles: string[] }> },
  seed: PlannerSeed,
  ownerAgent: Agent,
): void {
  const groundedCriteria = parsed.criteria.map((c, idx) => {
    const { grounded, stripped, rebound } = groundExpectedFiles(c.expectedFiles, seed.repoFiles);
    for (const rb of rebound) {
      state.findings.post({
        agentId: ownerAgent.id,
        text: `Contract c${idx + 1}: rebound '${rb.from}' → '${rb.to}'.`,
        createdAt: Date.now(),
      });
    }
    for (const r of stripped) {
      state.findings.post({
        agentId: ownerAgent.id,
        text: `Contract c${idx + 1}: stripped ungrounded path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    if (stripped.length > 0 || rebound.length > 0) {
      state.appendSystem(
        `Contract c${idx + 1}: ${stripped.length} stripped, ${rebound.length} rebound(s) — expectedFiles=${JSON.stringify(grounded)}.`,
      );
    }
    const canonical = canonicalizeExpectedFiles(grounded, seed.repoFiles);
    return { description: c.description, expectedFiles: canonical };
  });

  const contract = buildContract({
    missionStatement: parsed.missionStatement,
    criteria: groundedCriteria,
  });
  state.contract = contract;
  state.currentTier = 1;
  state.tierStartedAt = Date.now();
  state.emit({ type: "contract_updated", contract: { ...contract, criteria: contract.criteria.map(c => ({ ...c })) } });

  if (contract.criteria.length === 0) {
    state.appendSystem(`Contract (tier 1): "${contract.missionStatement}" (0 criteria).`);
  } else {
    state.appendSystem(`Contract (tier 1): "${contract.missionStatement}" (${contract.criteria.length} criteria).`);
  }
}

export async function runTierPromotion(
  state: CouncilAdapterState,
  planner: Agent,
  maxTiers: number,
): Promise<boolean> {
  if (state.currentTier >= maxTiers) return false;

  const seed = await buildSeed(
    councilBuildSeedContext(state, planner),
    state.clonePath,
    state.cfg,
  );

  const nextTier = state.currentTier + 1;
  const metCriteria = state.contract?.criteria.filter(c => c.status === "met") ?? [];
  const directive = state.cfg.userDirective ?? "(none provided)";
  const { buildCouncilAmbitionTierPrompt } = await import("./councilPromptHelpers.js");
  const prompt = buildCouncilAmbitionTierPrompt({
    directive,
    missionStatement: state.contract?.missionStatement ?? "Build the project",
    metCriteria,
    nextTier,
    currentTier: state.currentTier,
    readmeExcerpt: seed.readmeExcerpt,
    repoFiles: seed.repoFiles,
  });

  const { response: raw, agentUsed } = await promptPlannerSafely(planner, prompt, "swarm", state.manager, state.cfg.providerFailover);
  if (state.stopping) return false;
  state.appendAgent(agentUsed, raw);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    state.appendSystem(`Tier promotion: no JSON found in response.`);
    return false;
  }

  try {
    const result = JSON.parse(jsonMatch[0]);
    const newCriteria: Array<{ description: string; expectedFiles: string[] }> =
      Array.isArray(result.criteria) ? result.criteria : [];

    if (newCriteria.length === 0) {
      state.appendSystem(`Tier promotion: planner proposed 0 criteria.`);
      return false;
    }

    const grounded = newCriteria.map((c) => {
      const { grounded: paths, stripped, rebound } = groundExpectedFiles(c.expectedFiles, seed.repoFiles);
      if (stripped.length > 0 || rebound.length > 0) {
        state.appendSystem(
          `Tier ${nextTier}: ${stripped.length} stripped, ${rebound.length} rebound(s) for "${c.description}".`,
        );
      }
      const canonical = canonicalizeExpectedFiles(paths, seed.repoFiles);
      return { description: c.description, expectedFiles: canonical };
    });

    const addedAt = Date.now();
    const newExitCriteria: ExitCriterion[] = grounded.map((c, i) => ({
      id: `c${(state.contract?.criteria.length ?? 0) + i + 1}`,
      description: c.description,
      expectedFiles: c.expectedFiles,
      status: "unmet" as const,
      addedAt,
    }));

    state.contract = {
      missionStatement: String(result.missionStatement ?? `Tier ${nextTier} work`),
      criteria: [...(state.contract?.criteria ?? []), ...newExitCriteria],
    };
    state.currentTier = nextTier;
    state.emit({ type: "contract_updated", contract: { ...state.contract, criteria: state.contract.criteria.map(c => ({ ...c })) } });
    state.appendSystem(`Tier ${nextTier}: "${state.contract.missionStatement}" (${newExitCriteria.length} new criteria).`);
    return true;
  } catch (err) {
    state.appendSystem(`Tier promotion: JSON parse failed (${err instanceof Error ? err.message : String(err)}).`);
    return false;
  }
}
