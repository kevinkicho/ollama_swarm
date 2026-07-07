// Extracted from BlackboardRunner.ts — first-pass contract orchestration.
// Manages running the initial contract prompt, council-mode dispatch,
// resume-from-snapshot, and contract grounding/finalization.
// Takes a narrow ContractContext object instead of referencing `this.*`.

import type { Agent } from "../../services/AgentManager.js";
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
import { classifyExpectedFiles } from "./prompts/pathValidation.js";
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
import {
  tryBrainFallback,
  type BrainFallbackEvent,
} from "./prompts/brainIntegration.js";
import { ContractSchema } from "./prompts/firstPassContract.js";
import { resolveToolProfile } from "../toolProfiles.js";

export interface ContractContext {
  // --- state getters ---
  getStopping: () => boolean;
  getActive: () => RunConfig | undefined;
  getContract: () => ExitContract | undefined;
  getPriorSnapshot: () => BlackboardStateSnapshot | null | undefined;
  getFindingsPost: () => (entry: { agentId: string; text: string; createdAt: number }) => void;

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
  getPlannerFallbackModel: () => string | undefined;
  updateAgentModel: (agentId: string, model: string) => void;
  promptPlannerSafely: (
    primaryAgent: Agent,
    promptText: string,
    agentName?: import("../../tools/ToolDispatcher.js").ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
  ) => Promise<{ response: string; agentUsed: Agent }>;
  promptAgent: (
    agent: Agent,
    prompt: string,
    agentName: import("../../tools/ToolDispatcher.js").ProfileName,
    formatExpect: "json" | "free",
    ollamaFormat?: "json" | Record<string, unknown>,
  ) => Promise<string>;
  emit: (e: unknown) => void;
  scheduleStateWrite: () => void;
  v2ObserverApply: (event: unknown) => void;

  /** Brain fallback: prompt an LLM to extract structured JSON from a
   *  failed parse. The promptFn signature matches promptWithFailover. */
  brainPromptFn?: (
    prompt: string,
    model: string,
    maxTokens: number,
    timeoutMs: number,
  ) => Promise<string>;

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

  const plannerProfile = resolveToolProfile("planner", ctx.getActive());

  const { response: firstResponse, agentUsed: contractAgent } = await ctx.promptPlannerSafely(
    agent,
    `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(seed, agent.model)}`,
    plannerProfile,
    CONTRACT_JSON_SCHEMA,
  );
  if (ctx.getStopping()) return;
  ctx.appendAgent(contractAgent, firstResponse);

  let parsed = parseFirstPassContractResponse(firstResponse);
  if (!parsed.ok) {
    ctx.appendSystem(
      `Contract response did not parse (${parsed.reason}). Retrying with full prompt.`,
    );
    const { response: retryResponse, agentUsed: retryAgent } = await ctx.promptPlannerSafely(
      contractAgent,
      `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(seed, contractAgent.model)}`,
      plannerProfile,
      CONTRACT_JSON_SCHEMA,
    );
    if (ctx.getStopping()) return;
    ctx.appendAgent(retryAgent, retryResponse);
    parsed = parseFirstPassContractResponse(retryResponse);
    if (!parsed.ok) {
      // Brain fallback: try AI-assisted parsing before sibling-retry.
      if (ctx.brainPromptFn) {
        ctx.appendSystem(`Contract parse still failed after repair — trying brain fallback (${parsed.reason}).`);
        try {
          const brainResult = await tryBrainFallback(
            "contract",
            firstResponse,
            ContractSchema,
            ctx.brainPromptFn,
            (e: BrainFallbackEvent) => { ctx.emit({ type: "brain-fallback", ...e }); },
            agent,
          );
          if (brainResult) {
            parsed = {
              ok: true as const,
              contract: {
                missionStatement: brainResult.missionStatement,
                criteria: brainResult.criteria.map((c: { description: string; expectedFiles: string[] }, i: number) => ({
                  id: `c${i + 1}`,
                  description: c.description,
                  expectedFiles: [...c.expectedFiles],
                  status: "unmet" as const,
                  addedAt: Date.now(),
                })),
              },
              dropped: [],
            };
            ctx.appendSystem(`Brain fallback succeeded — extracted contract with ${brainResult.criteria.length} criterion(crite)ria.`);
          }
        } catch {
          // Brain call failed — fall through to sibling-retry.
        }
      }
    }
    if (!parsed.ok) {
      const retried = await withSiblingRetry(
        {
          agent,
          modelAtEntry,
          logPrefix: `[${agent.id}]`,
          updateAgentModel: ctx.updateAgentModel,
          emit: ctx.emit,
          getFallbackModel: ctx.getPlannerFallbackModel,
          reason: "sibling-retry: contract JSON parse failed after repair",
        },
        async () => {
          await runFirstPassContract(ctx, agent, seed, true);
        },
      );
      if (retried) return;
      ctx.appendSystem(
        `Contract still invalid after repair (${parsed.reason}). Proceeding without a contract.`,
      );
      return;
    }
  }

  if (parsed.dropped.length > 0) {
    ctx.appendSystem(
      `Dropped ${parsed.dropped.length} invalid criterion(s): ${parsed.dropped
        .map((d) => d.reason)
        .join(" | ")}`,
    );
  }

  finalizeContract(ctx, parsed.contract, seed, agent);
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
  const draftPrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(
    seed,
    planner.model,
  )}`;

  ctx.appendSystem(
    `Council contract: prompting ${allAgents.length} agents for independent first-pass drafts.`,
  );

  const draftResults = await Promise.allSettled(
    allAgents.map(async (a) => {
      const text = await ctx.promptAgent(a, draftPrompt, "swarm", "json", CONTRACT_JSON_SCHEMA);
      return { agent: a, text };
    }),
  );

  const drafts: CouncilContractDraft[] = [];
  for (const r of draftResults) {
    if (r.status !== "fulfilled") {
      ctx.appendSystem(
        `Council draft prompt rejected: ${
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        }`,
      );
      continue;
    }
    ctx.appendAgent(r.value.agent, r.value.text);
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
  const groundedCriteria = parsed.criteria.map((c, idx) => {
    const { accepted, rejected } = classifyExpectedFiles(c.expectedFiles, seed.repoFiles);
    for (const r of rejected) {
      ctx.getFindingsPost()({
        agentId: ownerAgent.id,
        text: `Contract c${idx + 1}: stripped suspicious path '${r.path}' (${r.reason}). Unit 5d linked-commit fallback will rebind from later commits.`,
        createdAt: Date.now(),
      });
    }
    if (rejected.length > 0) {
      ctx.appendSystem(
        `Contract c${idx + 1}: ${rejected.length}/${c.expectedFiles.length} path(s) stripped as unbindable — criterion kept with expectedFiles=${JSON.stringify(accepted)}.`,
      );
    }
    return { description: c.description, expectedFiles: accepted };
  });
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
  ctx.emit({ type: "contract_updated", contract: cloneContract(contract) });
  ctx.scheduleStateWrite();
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

  let codeContextExcerpts: ReadonlyArray<{ path: string; excerpt: string }> | undefined;
  try {
    const directive = (cfg.userDirective ?? "").trim();
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
  const systemMap = `System overview for ${cfg.userDirective || 'the project'}:
- Top level dirs: ${topLevel.slice(0,5).join(', ')}
- Key files (sample): ${repoFiles.slice(0,10).join(', ')}
- README summary: ${readmeExcerpt ? readmeExcerpt.slice(0,200) : 'N/A'}
This is a lightweight map to help with systemic planning without full repo dump.`;

  return {
    repoUrl: cfg.repoUrl,
    clonePath,
    topLevel,
    repoFiles,
    readmeExcerpt,
    userDirective: cfg.userDirective,
    priorRunSummary,
    priorMemoryRendered,
    priorDesignMemoryRendered,
    workerTags,
    ...(codeContextExcerpts ? { codeContextExcerpts } : {}),
    ...(cfg.testDrivenTodos ? { testDrivenTodos: true } : {}),
    ...(cfg.parallelHypothesis ? { parallelHypothesis: true } : {}),
    systemMap,  // for planner to use for broad view
  };
}
