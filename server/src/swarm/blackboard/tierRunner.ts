// Extracted from BlackboardRunner.ts — tier-ratchet + audited-execution subsystem.
// Manages the drain-audit-repeat loop, tier-up promotion, and related helpers.
// Takes a narrow TierContext object instead of referencing `this.*`.

import type { Agent } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ExitContract, Todo } from "./types.js";
import type { BoardCounts } from "./types.js";
import {
  buildTierUpPrompt,
  buildFirstPassContractRepairPrompt,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
} from "./prompts/firstPassContract.js";
import { CONTRACT_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { classifyExpectedFiles } from "./prompts/pathValidation.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import { config as appConfig } from "../../config.js";

export interface TierContext {
  // --- state getters ---
  getContract: () => ExitContract | undefined;
  getActive: () => RunConfig | undefined;
  getStopping: () => boolean;
  getCurrentTier: () => number;
  getTiersCompleted: () => number;
  getTierHistory: () => TierHistoryEntry[];
  getTierStartedAt: () => number | undefined;
  getTierUpFailures: () => number;
  getAuditInvocations: () => number;
  getCompletionDetail: () => string | undefined;

  // --- state setters ---
  setCurrentTier: (t: number) => void;
  setTiersCompleted: (t: number) => void;
  setTierStartedAt: (t: number | undefined) => void;
  setTierHistory: (h: TierHistoryEntry[]) => void;
  setTierUpFailures: (t: number) => void;
  setCompletionDetail: (d: string | undefined) => void;
  setContract: (c: ExitContract | undefined) => void;

  // --- callbacks ---
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  promptPlannerSafely: (
    primaryAgent: Agent,
    promptText: string,
    agentName?: "swarm" | "swarm-read" | "swarm-builder",
    ollamaFormat?: "json" | Record<string, unknown>,
  ) => Promise<{ response: string; agentUsed: Agent }>;
  emit: (e: unknown) => void;
  scheduleStateWrite: () => void;
  cloneContract: (c: ExitContract) => ExitContract;
  directiveWithAmendments: () => string | undefined;
  logDiag: ((entry: unknown) => void) | undefined;
  boardListTodos: () => Todo[];
  boardCounts: () => BoardCounts;
  readReadme: (clonePath: string) => Promise<string | null>;
  listRepoFiles: (clonePath: string, opts: { maxFiles: number }) => Promise<string[]>;
  findPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
  checkAndApplyCaps: () => boolean;
  runWorkers: (workers: Agent[]) => Promise<void>;
  runAuditor: (planner: Agent, opts?: { allowWhenStopping?: boolean }) => Promise<void>;
  runPlannerFallbackForUnmetCriteria: (planner: Agent) => Promise<boolean>;
  v2ObserverApply: (event: unknown) => void;
}

export interface TierHistoryEntry {
  tier: number;
  missionStatement: string;
  criteriaTotal: number;
  criteriaMet: number;
  criteriaWontDo: number;
  criteriaUnmet: number;
  wallClockMs: number;
  startedAt: number;
  endedAt: number;
}

export function allCriteriaResolved(ctx: TierContext): boolean {
  const contract = ctx.getContract();
  if (!contract) return true;
  return contract.criteria.every((c) => c.status !== "unmet");
}

export function allCriteriaResolvedSnapshot(ctx: TierContext): boolean {
  const contract = ctx.getContract();
  if (!contract) return false;
  return contract.criteria.every(
    (c) => c.status === "met" || c.status === "wont-do",
  );
}

export function resolvedMaxTiers(ctx: TierContext): number {
  const perRun = ctx.getActive()?.ambitionTiers;
  if (perRun !== undefined) {
    return Math.max(1, perRun);
  }
  if (!appConfig.AMBITION_RATCHET_ENABLED) return 1;
  return appConfig.AMBITION_RATCHET_MAX_TIERS;
}

export function maxAuditInvocations(ctx: TierContext): number {
  return ctx.getActive()?.rounds ?? 5;
}

export function largestCriterionIdNumber(ctx: TierContext): number {
  const contract = ctx.getContract();
  if (!contract) return 0;
  let max = 0;
  for (const c of contract.criteria) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

export function recordTierCompletion(ctx: TierContext): void {
  const contract = ctx.getContract();
  const currentTier = ctx.getCurrentTier();
  if (!contract || currentTier < 1) return;
  const now = Date.now();
  const startedAt = ctx.getTierStartedAt() ?? now;
  const tierCriteria = contract.criteria.filter(
    (c) => c.addedAt >= startedAt,
  );
  const met = tierCriteria.filter((c) => c.status === "met").length;
  const wontDo = tierCriteria.filter((c) => c.status === "wont-do").length;
  const unmet = tierCriteria.filter((c) => c.status === "unmet").length;
  const history = [...ctx.getTierHistory()];
  history.push({
    tier: currentTier,
    missionStatement: contract.missionStatement,
    criteriaTotal: tierCriteria.length,
    criteriaMet: met,
    criteriaWontDo: wontDo,
    criteriaUnmet: unmet,
    wallClockMs: Math.max(0, now - startedAt),
    startedAt,
    endedAt: now,
  });
  ctx.setTierHistory(history);
  ctx.setTiersCompleted(ctx.getTiersCompleted() + 1);
}

export async function tryPromoteNextTier(
  ctx: TierContext,
  planner: Agent,
  maxTiers: number,
): Promise<boolean> {
  const contract = ctx.getContract();
  const active = ctx.getActive();
  if (!contract || !active) return false;
  const nextTier = ctx.getCurrentTier() + 1;
  ctx.appendSystem(
    `Ambition ratchet: all tier ${ctx.getCurrentTier()} criteria resolved; attempting tier ${nextTier} (max ${maxTiers}).`,
  );

  const committed = ctx.boardListTodos().filter((t) => t.status === "committed");
  const committedFiles = Array.from(
    new Set(committed.flatMap((t) => t.expectedFiles)),
  );

  const priorCriteria = contract.criteria.map((c) => ({
    id: c.id,
    description: c.description,
    status: c.status,
    rationale: c.rationale,
    expectedFiles: [...c.expectedFiles],
  }));

  const clone = active.localPath;
  const readmeExcerpt = await ctx.readReadme(clone).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logDiag?.({ type: "_tier_up_readme_failed", clone, error: msg });
    ctx.appendSystem(`Tier-up README read failed (${msg}); planner gets no README context.`);
    return null;
  });
  const repoFiles = await ctx.listRepoFiles(clone, { maxFiles: 150 }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logDiag?.({ type: "_tier_up_files_failed", clone, error: msg });
    ctx.appendSystem(`Tier-up file list failed (${msg}); planner gets empty file list.`);
    return [] as string[];
  });

  const prompt = buildTierUpPrompt({
    nextTier,
    maxTiers,
    priorMissionStatement: contract.missionStatement,
    priorCriteria,
    committedFiles,
    repoFiles,
    readmeExcerpt,
    userDirective: ctx.directiveWithAmendments(),
  });

  const { response, agentUsed } = await ctx.promptPlannerSafely(
    planner,
    prompt,
    undefined,
    CONTRACT_JSON_SCHEMA,
  );
  if (ctx.getStopping()) return false;
  ctx.appendAgent(agentUsed, response);

  let parsed = parseFirstPassContractResponse(response);
  if (!parsed.ok) {
    ctx.appendSystem(
      `Tier ${nextTier} response did not parse (${parsed.reason}). Issuing repair prompt.`,
    );
    const { response: repairResponse, agentUsed: repairAgent } =
      await ctx.promptPlannerSafely(
        agentUsed,
        `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
          response,
          parsed.reason,
        )}`,
        undefined,
        CONTRACT_JSON_SCHEMA,
      );
    if (ctx.getStopping()) return false;
    ctx.appendAgent(repairAgent, repairResponse);
    parsed = parseFirstPassContractResponse(repairResponse);
    if (!parsed.ok) {
      ctx.setTierUpFailures(ctx.getTierUpFailures() + 1);
      ctx.appendSystem(
        `Tier ${nextTier} still invalid after repair (${parsed.reason}). Ratchet failure ${ctx.getTierUpFailures()}/3.`,
      );
      return false;
    }
  }
  if (parsed.contract.criteria.length === 0) {
    ctx.setTierUpFailures(ctx.getTierUpFailures() + 1);
    ctx.appendSystem(
      `Tier ${nextTier} produced 0 criteria — planner saw nothing left to do. Ratchet failure ${ctx.getTierUpFailures()}/3.`,
    );
    return false;
  }

  ctx.setTierUpFailures(0);

  const priorMaxId = largestCriterionIdNumber(ctx);
  const tierStartedAt = Date.now();
  const appendedCriteria = parsed.contract.criteria.map((c, idx) => {
    const { accepted, rejected } = classifyExpectedFiles(c.expectedFiles, repoFiles);
    for (const r of rejected) {
      ctx.findPost({
        agentId: planner.id,
        text: `Tier ${nextTier} c${priorMaxId + idx + 1}: stripped suspicious path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    if (rejected.length > 0) {
      ctx.appendSystem(
        `Tier ${nextTier} c${priorMaxId + idx + 1}: ${rejected.length}/${c.expectedFiles.length} path(s) stripped as unbindable.`,
      );
    }
    return {
      id: `c${priorMaxId + idx + 1}`,
      description: c.description,
      expectedFiles: accepted,
      status: "unmet" as const,
      addedAt: tierStartedAt,
    };
  });

  const newContract: ExitContract = {
    missionStatement: parsed.contract.missionStatement,
    criteria: [...contract.criteria, ...appendedCriteria],
  };
  ctx.setContract(newContract);
  ctx.setCurrentTier(nextTier);
  ctx.setTierStartedAt(tierStartedAt);
  ctx.emit({
    type: "contract_updated",
    contract: ctx.cloneContract(newContract),
  });
  ctx.scheduleStateWrite();
  ctx.appendSystem(
    `Contract (tier ${nextTier}): "${newContract.missionStatement}" (+${appendedCriteria.length} new criteria, ${newContract.criteria.length} total).`,
  );
  return true;
}

export async function runAuditedExecution(
  ctx: TierContext,
  planner: Agent,
  workers: Agent[],
): Promise<void> {
  while (!ctx.getStopping()) {
    if (ctx.checkAndApplyCaps()) return;
    await ctx.runWorkers(workers);
    if (ctx.getStopping()) return;

    if (!ctx.getContract() || ctx.getContract()!.criteria.length === 0) return;

    if (allCriteriaResolved(ctx)) {
      const maxTiers = resolvedMaxTiers(ctx);
      if (
        maxTiers > 1 &&
        ctx.getCurrentTier() < maxTiers &&
        ctx.getTierUpFailures() < 3 &&
        !ctx.getStopping()
      ) {
        recordTierCompletion(ctx);
        const promoted = await tryPromoteNextTier(ctx, planner, maxTiers);
        if (ctx.getStopping()) return;
        ctx.v2ObserverApply({
          type: "tier-up-decision",
          ts: Date.now(),
          promoted,
        });
        if (promoted) {
          continue;
        }
        ctx.setCompletionDetail(
          "all tier criteria satisfied; tier-up failed after retries — ending run.",
        );
        ctx.appendSystem(ctx.getCompletionDetail()!);
        return;
      }
      recordTierCompletion(ctx);
      const currentTier = ctx.getCurrentTier();
      ctx.setCompletionDetail(
        currentTier > 1
          ? `all tier ${currentTier} criteria satisfied; ratchet cap reached (${maxTiers} tier${maxTiers === 1 ? "" : "s"}).`
          : "all contract criteria satisfied",
      );
      ctx.appendSystem("All contract criteria resolved. Stopping.");
      return;
    }

    const cap = maxAuditInvocations(ctx);
    if (ctx.getAuditInvocations() >= cap) {
      ctx.setCompletionDetail(`auditor invocation cap reached (${cap})`);
      ctx.appendSystem(
        `Auditor invocation cap reached (${cap}). Stopping with unresolved criteria. Raise "Rounds" on the setup form if you want more plan-audit cycles.`,
      );
      return;
    }

    const openBefore = ctx.boardCounts().open;
    await ctx.runAuditor(planner);
    if (ctx.getStopping()) return;

    const openAfter = ctx.boardCounts().open;
    if (openAfter === openBefore && !allCriteriaResolved(ctx) && openAfter === 0) {
      const fallbackSucceeded = await ctx.runPlannerFallbackForUnmetCriteria(planner);
      if (ctx.getStopping()) return;
      if (fallbackSucceeded) {
        continue;
      }
      ctx.setCompletionDetail("auditor + planner produced no new work; unresolved criteria remain");
      ctx.appendSystem(ctx.getCompletionDetail()! + ".");
      return;
    }
  }
}