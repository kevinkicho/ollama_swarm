// Extracted from BlackboardRunner.ts — tier-ratchet + audited-execution subsystem.
// Manages the drain-audit-repeat loop, tier-up promotion, and related helpers.
// Takes a narrow TierContext object instead of referencing `this.*`.

const MAX_STUCK_CYCLES_FOR_INFINITE_RUN = 3;

import type { Agent } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ExitContract, Todo } from "./types.js";
import type { BoardCounts } from "./types.js";
import {
  buildTierUpPrompt,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
} from "./prompts/firstPassContract.js";
import { CONTRACT_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { groundExpectedFiles } from "./contractGrounding.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import { config as appConfig } from "../../config.js";
import { resolveToolProfile } from "../toolProfiles.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";

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
  getConsecutiveStuckCycles: () => number;

  // --- state setters ---
  setCurrentTier: (t: number) => void;
  setTiersCompleted: (t: number) => void;
  setTierStartedAt: (t: number | undefined) => void;
  setTierHistory: (h: TierHistoryEntry[]) => void;
  setTierUpFailures: (t: number) => void;
  setCompletionDetail: (d: string | undefined) => void;
  setContract: (c: ExitContract | undefined) => void;
  setConsecutiveStuckCycles: (n: number) => void;

  // --- callbacks ---
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  promptPlannerSafely: (
    primaryAgent: Agent,
    promptText: string,
    agentName?: ProfileName,
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
  wastedWallClockMs: number;
  startedAt: number;
  endedAt: number;
}

export function allCriteriaResolved(ctx: TierContext): boolean {
  const contract = ctx.getContract();
  if (!contract) return true;
  return contract.criteria.every((c) => c.status !== "unmet");
}

export function allCriteriaMet(ctx: TierContext): boolean {
  const contract = ctx.getContract();
  if (!contract) return true;
  return contract.criteria.every((c) => c.status === "met");
}

export function allCriteriaResolvedSnapshot(ctx: TierContext): boolean {
  const contract = ctx.getContract();
  if (!contract) return false;
  return contract.criteria.every(
    (c) => c.status === "met" || c.status === "wont-do",
  );
}

export function resolvedMaxTiers(ctx: TierContext): number {
  const active = ctx.getActive();
  if (active?.rounds === 0 || (active?.rounds ?? 0) >= 1_000_000) return Infinity; // autonomous/continuous mode — no tier cap
  const perRun = active?.ambitionTiers;
  if (perRun !== undefined) {
    return Math.max(1, perRun);
  }
  if (!appConfig.AMBITION_RATCHET_ENABLED) return 1;
  return appConfig.AMBITION_RATCHET_MAX_TIERS;
}

export function maxAuditInvocations(ctx: TierContext): number {
  const rounds = ctx.getActive()?.rounds;
  if (rounds === 0 || (rounds ?? 0) >= 1_000_000) return Infinity; // autonomous/continuous mode — no hard cap
  return rounds ?? 5;
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
    wastedWallClockMs: 0,
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
  const repoFiles = await ctx.listRepoFiles(clone, { maxFiles: 500 }).catch((err: unknown) => {
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

  const plannerProfile = resolveToolProfile("planner", ctx.getActive());
  const { response, agentUsed } = await ctx.promptPlannerSafely(
    planner,
    prompt,
    plannerProfile,
    CONTRACT_JSON_SCHEMA,
  );
  if (ctx.getStopping()) return false;
  ctx.appendAgent(agentUsed, response);

  let parsed = parseFirstPassContractResponse(response);
  if (!parsed.ok) {
    ctx.appendSystem(
      `Tier ${nextTier} response did not parse (${parsed.reason}). Retrying with full prompt.`,
    );
    // Retry with the full original prompt instead of a minimal repair prompt.
    // The repair prompt strips repo context, directive, and prior criteria —
    // without that context the model can't generate a meaningful contract.
    const { response: retryResponse, agentUsed: retryAgent } =
      await ctx.promptPlannerSafely(
        agentUsed,
        prompt,
        plannerProfile,
        CONTRACT_JSON_SCHEMA,
      );
    if (ctx.getStopping()) return false;
    ctx.appendAgent(retryAgent, retryResponse);
    parsed = parseFirstPassContractResponse(retryResponse);
    if (!parsed.ok) {
      ctx.setTierUpFailures(ctx.getTierUpFailures() + 1);
      ctx.appendSystem(
        `Tier ${nextTier} still invalid after retry (${parsed.reason}). Ratchet failure ${ctx.getTierUpFailures()}/3.`,
      );
      return false;
    }
  }
  if (parsed.contract.criteria.length === 0) {
    // In continuous mode (rounds=0), 0 criteria doesn't mean stop —
    // the planner just couldn't find new work this cycle. Keep going
    // by NOT incrementing tierUpFailures. The run continues with the
    // existing contract and the auditor will keep evaluating.
    if (active?.rounds === 0 || (active?.rounds ?? 0) >= 1_000_000) {
      ctx.appendSystem(
        `Tier ${nextTier} produced 0 criteria — planner saw nothing left to add. In continuous mode, keeping existing contract active.`,
      );
      // Don't promote, but don't fail either — just continue with current tier
      return false;
    }
    ctx.setTierUpFailures(ctx.getTierUpFailures() + 1);
    ctx.appendSystem(
      `Tier ${nextTier} produced 0 criteria — planner saw nothing left to do. Ratchet failure ${ctx.getTierUpFailures()}/3.`,
    );
    return false;
  }

  // Reject degenerate contracts that don't propose real new work.
  // After compaction the planner may lose context and produce trivially-met
  // criteria like "read the repo files" or "determine current state".
  const degeneratePatterns = [
    /read (the )?(repo|repository|project) file/i,
    /determine (the )?current state/i,
    /review (the )?(code|project|files)/i,
    /readme/i,
    /key files/i,
  ];
  const realCriteria = parsed.contract.criteria.filter((c) => {
    const desc = c.description.toLowerCase();
    const hasRealFiles = (c.expectedFiles ?? []).some(
      (f: string) => f.startsWith("src/") || f.startsWith("server/") || f.startsWith("tests/"),
    );
    if (hasRealFiles) return true;
    return !degeneratePatterns.some((p) => p.test(desc));
  });
  if (realCriteria.length === 0) {
    // In continuous mode, degenerate criteria don't count as failures either
    if (active?.rounds === 0 || (active?.rounds ?? 0) >= 1_000_000) {
      ctx.appendSystem(
        `Tier ${nextTier} produced ${parsed.contract.criteria.length} degenerate criterion(crite)ria (no real file targets) — in continuous mode, keeping existing contract active.`,
      );
      return false;
    }
    ctx.setTierUpFailures(ctx.getTierUpFailures() + 1);
    ctx.appendSystem(
      `Tier ${nextTier} produced ${parsed.contract.criteria.length} degenerate criterion(crite)ria (no real file targets) — rejecting. Ratchet failure ${ctx.getTierUpFailures()}/3.`,
    );
    return false;
  }
  if (realCriteria.length < parsed.contract.criteria.length) {
    ctx.appendSystem(
      `Tier ${nextTier}: filtered ${parsed.contract.criteria.length - realCriteria.length} degenerate criterion(crite)ria, ${realCriteria.length} remain.`,
    );
    parsed.contract.criteria = realCriteria;
  }

  ctx.setTierUpFailures(0);

  const priorMaxId = largestCriterionIdNumber(ctx);
  const tierStartedAt = Date.now();
  const appendedCriteria = parsed.contract.criteria.map((c, idx) => {
    const { grounded, stripped, rebound } = groundExpectedFiles(c.expectedFiles, repoFiles);
    for (const rb of rebound) {
      ctx.findPost({
        agentId: planner.id,
        text: `Tier ${nextTier} c${priorMaxId + idx + 1}: rebound '${rb.from}' → '${rb.to}'.`,
        createdAt: Date.now(),
      });
    }
    for (const r of stripped) {
      ctx.findPost({
        agentId: planner.id,
        text: `Tier ${nextTier} c${priorMaxId + idx + 1}: stripped ungrounded path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    if (stripped.length > 0 || rebound.length > 0) {
      ctx.appendSystem(
        `Tier ${nextTier} c${priorMaxId + idx + 1}: ${stripped.length} stripped, ${rebound.length} rebound(s) — expectedFiles=${JSON.stringify(grounded)}.`,
      );
    }
    if (grounded.length === 0 && c.expectedFiles.length > 0) {
      ctx.appendSystem(
        `Tier ${nextTier} c${priorMaxId + idx + 1}: auto-marking as wont-do — all ${c.expectedFiles.length} expectedFile(s) rejected by grounding check.`,
      );
      return {
        id: `c${priorMaxId + idx + 1}`,
        description: c.description,
        expectedFiles: [],
        status: "wont-do" as const,
        addedAt: tierStartedAt,
      };
    }
    return {
      id: `c${priorMaxId + idx + 1}`,
      description: c.description,
      expectedFiles: grounded,
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

    const pendingCommitTodos = ctx
      .boardListTodos()
      .filter((t) => t.status === "pending-commit");
    if (pendingCommitTodos.length > 0) {
      ctx.appendSystem(
        `[auditor-gate] Workers drained with ${pendingCommitTodos.length} pending commit(s) — auditor will review next.`,
      );
    }

    if (!ctx.getContract() || ctx.getContract()!.criteria.length === 0) return;

    if (allCriteriaMet(ctx)) {
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
        // In continuous mode, don't stop when tier-up fails — keep going
        // with the existing contract. The auditor will keep evaluating.
        const activeCfg = ctx.getActive();
        if (activeCfg?.rounds === 0 || (activeCfg?.rounds ?? 0) >= 1_000_000) {
          ctx.appendSystem(
            `Tier promotion failed in continuous mode — keeping existing contract active.`,
          );
          continue;
        }
        ctx.setCompletionDetail(
          "all tier criteria met; tier-up failed after retries — ending run.",
        );
        ctx.appendSystem(ctx.getCompletionDetail()!);
        return;
      }
      recordTierCompletion(ctx);
      const currentTier = ctx.getCurrentTier();
      ctx.setCompletionDetail(
        currentTier > 1
          ? `all tier ${currentTier} criteria met; ratchet cap reached (${maxTiers} tier${maxTiers === 1 ? "" : "s"}).`
          : "all contract criteria met",
      );
      ctx.appendSystem("All contract criteria met. Stopping.");
      return;
    }

    // All resolved (met or wont-do) but not all met — partial progress.
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
        // Tier promotion failed (0 criteria or parse failure) — retry
        // instead of falling through to stop. The planner may succeed on
        // the next cycle with a different angle. The tierUpFailures
        // counter inside tryPromoteNextTier caps retries at 3.
        ctx.appendSystem(
          `Tier promotion failed (${ctx.getTierUpFailures()}/3) — retrying next cycle.`,
        );
        continue;
      }
      const contract = ctx.getContract();
      const wontDoCount = contract?.criteria.filter((c) => c.status === "wont-do").length ?? 0;
      const metCount = contract?.criteria.filter((c) => c.status === "met").length ?? 0;
      ctx.setCompletionDetail(
        `${metCount} criterion(crite)ria met, ${wontDoCount} wont-do; remaining unresolvable`,
      );
      ctx.appendSystem(ctx.getCompletionDetail()!);
      return;
    }

    const cap = maxAuditInvocations(ctx);
    if (ctx.getAuditInvocations() >= cap) {
      ctx.setCompletionDetail(`auditor invocation cap reached (${cap})`);
      ctx.appendSystem(
        cap === Infinity
          ? "All criteria resolved — ratchet satisfied."
          : `Auditor invocation cap reached (${cap}). Stopping with unresolved criteria. Set rounds=0 for autonomous mode.`,
      );
      return;
    }

    const openBefore = ctx.boardCounts().open;
    try {
      await ctx.runAuditor(planner);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Auditor failed (${msg}) — skipping this cycle, will retry next.`);
    }
    if (ctx.getStopping()) return;

    const openAfter = ctx.boardCounts().open;
    if (openAfter === openBefore && !allCriteriaResolved(ctx) && openAfter === 0) {
      let fallbackSucceeded = false;
      try {
        fallbackSucceeded = await ctx.runPlannerFallbackForUnmetCriteria(planner);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Planner fallback failed (${msg}) — will retry next cycle.`);
      }
      if (ctx.getStopping()) return;
      if (fallbackSucceeded) {
        ctx.setConsecutiveStuckCycles(0);
        continue;
      }
      const stuckCycles = ctx.getConsecutiveStuckCycles() + 1;
      ctx.setConsecutiveStuckCycles(stuckCycles);
      const r = ctx.getActive()?.rounds ?? 1;
      const isAutonomous = r === 0 || r >= 1_000_000;
      if (isAutonomous && stuckCycles < MAX_STUCK_CYCLES_FOR_INFINITE_RUN) {
        ctx.appendSystem(
          `Stuck cycle ${stuckCycles}/${MAX_STUCK_CYCLES_FOR_INFINITE_RUN} — auditor + planner produced no new work; re-trying in autonomous mode.`,
        );
        continue;
      }
      ctx.setCompletionDetail("auditor + planner produced no new work; unresolved criteria remain");
      ctx.appendSystem(ctx.getCompletionDetail()! + ".");
      return;
    }
    ctx.setConsecutiveStuckCycles(0);
  }
}
