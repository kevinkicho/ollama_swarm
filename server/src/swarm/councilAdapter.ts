import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { ExitContract, ExitCriterion, Todo as BoardTodo } from "./blackboard/types.js";
import { TodoQueue, type PostTodoInput } from "./blackboard/TodoQueue.js";
import { FindingsLog } from "./blackboard/FindingsLog.js";
import { classifyExpectedFiles } from "./blackboard/prompts/pathValidation.js";
import {
  buildFirstPassContractUserPrompt,
  parseFirstPassContractResponse,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
} from "./blackboard/prompts/firstPassContract.js";
import { buildContract } from "./blackboard/contractBuilder.js";
import { buildSeed } from "./blackboard/contractBuilder.js";
import type { PlannerSeed } from "./blackboard/prompts/planner.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText } from "./councilUtils.js";

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
  runStartedAt: number | undefined;
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void };
  repos: { listTopLevel: (p: string) => Promise<string[]>; readReadme: (p: string) => Promise<string | null>; listRepoFiles: (p: string, opts: { maxFiles: number }) => Promise<string[]> };
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  emit: (e: unknown) => void;
  logDiag: (entry: Record<string, unknown>) => void;
}

export function buildCouncilAdapterState(
  cfg: RunConfig,
  clonePath: string,
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void },
  repos: { listTopLevel: (p: string) => Promise<string[]>; readReadme: (p: string) => Promise<string | null>; listRepoFiles: (p: string, opts: { maxFiles: number }) => Promise<string[]> },
  appendSystem: (msg: string) => void,
  appendAgent: (agent: Agent, text: string) => void,
  emit: (e: unknown) => void,
  logDiag: (entry: Record<string, unknown>) => void,
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
    appendSystem,
    appendAgent,
    emit,
    logDiag,
  };
}

export async function promptAgent(
  agent: Agent,
  prompt: string,
  agentName: import("../tools/ToolDispatcher.js").ProfileName,
  formatExpect: "json" | "free",
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void },
  providerFailover?: readonly string[],
): Promise<string> {
  const raw = await promptWithFailoverAuto(agent, prompt, {
    manager: manager as any,
    agentName,
    signal: new AbortController().signal,
  }, providerFailover);
  const text = extractProviderText(raw);
  return text ?? "";
}

export async function promptPlannerSafely(
  agent: Agent,
  promptText: string,
  agentName: import("../tools/ToolDispatcher.js").ProfileName | undefined,
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void },
  providerFailover?: readonly string[],
): Promise<{ response: string; agentUsed: Agent }> {
  const raw = await promptWithFailoverAuto(agent, promptText, {
    manager: manager as any,
    agentName: agentName ?? "swarm-read",
    signal: new AbortController().signal,
  }, providerFailover);
  const text = extractProviderText(raw);
  return { response: text ?? "", agentUsed: agent };
}

export async function runContractDerivation(
  state: CouncilAdapterState,
  planner: Agent,
  workers: Agent[],
): Promise<void> {
  const seed = await buildSeed(
    {
      getStopping: () => state.stopping,
      getActive: () => state.cfg,
      getContract: () => state.contract,
      getPriorSnapshot: () => null,
      getFindingsPost: () => (entry: { agentId: string; text: string; createdAt: number }) => {
        state.findings.post(entry);
      },
      setContract: (c) => { state.contract = c; },
      setCurrentTier: (t) => { state.currentTier = t; },
      setTiersCompleted: (t) => { state.tiersCompleted = t; },
      setTierStartedAt: (t) => { state.tierStartedAt = t; },
      setTierHistory: (h) => { state.tierHistory = h; },
      appendSystem: state.appendSystem,
      appendAgent: state.appendAgent,
      getPlannerFallbackModel: () => undefined,
      updateAgentModel: () => {},
      promptPlannerSafely: (agent, promptText, agentName) =>
        promptPlannerSafely(agent, promptText, agentName, state.manager, state.cfg.providerFailover),
      promptAgent: (agent, prompt, agentName, formatExpect) =>
        promptAgent(agent, prompt, agentName, formatExpect, state.manager, state.cfg.providerFailover),
      emit: state.emit,
      scheduleStateWrite: () => {},
      v2ObserverApply: () => {},
      repos: state.repos,
    },
    state.clonePath,
    state.cfg,
  );

  // Run council-style contract (all agents propose, planner merges)
  const allAgents = [planner, ...workers];
  const draftPrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(seed)}`;

  state.appendSystem(
    `Council contract: prompting ${allAgents.length} agents for independent first-pass drafts.`,
  );

  const draftResults = await Promise.allSettled(
    allAgents.map(async (a) => {
      const text = await promptAgent(a, draftPrompt, "swarm", "json", state.manager, state.cfg.providerFailover);
      return { agent: a, text };
    }),
  );

  const drafts: Array<{ agentId: string; contract: any }> = [];
  for (const r of draftResults) {
    if (r.status !== "fulfilled") continue;
    state.appendAgent(r.value.agent, r.value.text);
    const parsed = parseFirstPassContractResponse(r.value.text);
    if (!parsed.ok) continue;
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
    finalizeContract(state, drafts[0].contract, seed, planner);
    return;
  }

  // Merge drafts via planner
  const { buildCouncilContractMergePrompt } = await import("./blackboard/prompts/firstPassContract.js");
  const mergePrompt = buildCouncilContractMergePrompt(seed, drafts);
  const { response: mergeResponse, agentUsed: mergeAgent } = await promptPlannerSafely(
    planner, mergePrompt, undefined, state.manager, state.cfg.providerFailover,
  );
  if (state.stopping) return;
  state.appendAgent(mergeAgent, mergeResponse);

  let mergeParsed = parseFirstPassContractResponse(mergeResponse);
  if (!mergeParsed.ok) {
    state.appendSystem(`Council merge did not parse (${mergeParsed.reason}). Using best draft.`);
    const best = drafts.reduce((a, b) =>
      b.contract.criteria.length > a.contract.criteria.length ? b : a,
    );
    finalizeContract(state, best.contract, seed, planner);
    return;
  }
  if (mergeParsed.dropped.length > 0) {
    state.appendSystem(`Council merge: dropped ${mergeParsed.dropped.length} invalid criterion(s).`);
  }
  finalizeContract(state, mergeParsed.contract, seed, planner);
}

function finalizeContract(
  state: CouncilAdapterState,
  parsed: { missionStatement: string; criteria: Array<{ description: string; expectedFiles: string[] }> },
  seed: PlannerSeed,
  ownerAgent: Agent,
): void {
  const groundedCriteria = parsed.criteria.map((c, idx) => {
    const { accepted, rejected } = classifyExpectedFiles(c.expectedFiles, seed.repoFiles);
    for (const r of rejected) {
      state.findings.post({
        agentId: ownerAgent.id,
        text: `Contract c${idx + 1}: stripped suspicious path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    if (rejected.length > 0) {
      state.appendSystem(
        `Contract c${idx + 1}: ${rejected.length}/${c.expectedFiles.length} path(s) stripped — kept with ${JSON.stringify(accepted)}.`,
      );
    }
    return { description: c.description, expectedFiles: accepted };
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
    {
      getStopping: () => state.stopping,
      getActive: () => state.cfg,
      getContract: () => state.contract,
      getPriorSnapshot: () => null,
      getFindingsPost: () => (entry: { agentId: string; text: string; createdAt: number }) => {
        state.findings.post(entry);
      },
      setContract: (c) => { state.contract = c; },
      setCurrentTier: (t) => { state.currentTier = t; },
      setTiersCompleted: (t) => { state.tiersCompleted = t; },
      setTierStartedAt: (t) => { state.tierStartedAt = t; },
      setTierHistory: (h) => { state.tierHistory = h; },
      appendSystem: state.appendSystem,
      appendAgent: state.appendAgent,
      getPlannerFallbackModel: () => undefined,
      updateAgentModel: () => {},
      promptPlannerSafely: (agent, promptText, agentName) =>
        promptPlannerSafely(agent, promptText, agentName, state.manager),
      promptAgent: (agent, prompt, agentName, formatExpect) =>
        promptAgent(agent, prompt, agentName, formatExpect, state.manager),
      emit: state.emit,
      scheduleStateWrite: () => {},
      v2ObserverApply: () => {},
      repos: state.repos,
    },
    state.clonePath,
    state.cfg,
  );

  const nextTier = state.currentTier + 1;
  const metCriteria = state.contract?.criteria.filter(c => c.status === "met") ?? [];
  const directive = state.cfg.userDirective ?? "(none provided)";
  const prompt = `You are the planner for a council of AI engineers. All current criteria are met.

User directive (the OVERALL goal): "${directive}"

Current contract mission: "${state.contract?.missionStatement ?? "Build the project"}"

Met criteria (${metCriteria.length}):
${metCriteria.map(c => `  [✓] ${c.description} — files: ${c.expectedFiles.join(", ") || "(none)"}`).join("\n")}

${seed.readmeExcerpt ? `README excerpt:\n${seed.readmeExcerpt}\n` : ""}

Project files (${seed.repoFiles.length} total):
${seed.repoFiles.slice(0, 100).join("\n")}

Your task: Propose a NEW set of criteria for tier ${nextTier} that ADVANCE the user's directive further.

RULES:
1. Every criterion MUST directly serve the user's directive. Do NOT propose unrelated features.
2. Every file path MUST appear in the PROJECT FILES list. Do NOT invent paths.
3. The tier must be MATERIALLY MORE AMBITIOUS than tier ${state.currentTier} — broader scope, deeper work, or capability the prior tier didn't touch.
4. Do NOT redo what's already met. Focus on what's STILL MISSING from the directive.
5. Think about what gaps remain in the project that prevent the directive from being fully achieved.
6. If you've already added all the panels the directive asks for, broaden scope: code quality, performance, testing, documentation, error handling, accessibility, or other improvements that make the app MORE ROBUST and MORE COMPLETE.

Return ONLY a JSON object:
{
  "missionStatement": "one-sentence summary of how this tier advances the directive",
  "criteria": [
    {"description": "specific feature that advances the directive", "expectedFiles": ["path/to/file.tsx"]}
  ]
}

Max 6 criteria. Each must be concrete, verifiable, and directly advance the user's directive.`;

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
      const { accepted, rejected } = classifyExpectedFiles(c.expectedFiles, seed.repoFiles);
      if (rejected.length > 0) {
        state.appendSystem(`Tier ${nextTier}: stripped ${rejected.length} invalid path(s) from "${c.description}".`);
      }
      return { description: c.description, expectedFiles: accepted };
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
