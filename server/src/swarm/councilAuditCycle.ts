/**
 * Council post-execution audit cycle: ledger reconcile, LLM audit,
 * stuck/stall gates, tier promotion, planner fallback.
 * Extracted from CouncilRunner.runAudit.
 */

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { SwarmEvent } from "../types.js";
import type { ExitContract } from "./blackboard/types.js";
import type { TodoQueue } from "./blackboard/TodoQueue.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { runTierPromotion } from "./councilAdapter.js";
import { runCouncilLlmAudit } from "./councilAuditor.js";
import {
  buildUnmetFailSignature,
  extractRecentProviderStallFromLedger,
  hasCommitProgressOnUnmet,
  unmetFailsAreTransientOnly,
  reconcileCriteriaFromLedger,
} from "./councilLedgerReconcile.js";
import { postCouncilTodoBatch } from "./councilTodoPlan.js";
import type { CouncilProgressLedger } from "./councilProgressLedger.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import type { StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText, parseJsonArrayFromResponse, createTimeoutController } from "./councilUtils.js";
import { resolveCouncilToolProfile } from "./toolProfiles.js";
import {
  formatNoProductiveProgressReason,
  isDurableProgress,
  updateZeroProgressStreak,
  DEFAULT_ZERO_PROGRESS_LIMIT,
  MAX_STRETCH_WAVES_PER_RUN,
  MAX_CRITERION_PROGRESS_WAVES_PER_RUN,
  mintProgressTodosFromUnmetCriteria,
  todoProgressSignature,
} from "./productiveProgress.js";
import { notifyGuardTrip } from "./guardNotify.js";
import { filterAuditTodosAgainstPermanentSkips } from "./councilSkipReconcile.js";
import { isPermanentSkipReason } from "./councilCycleSettlement.js";

export interface CouncilAuditHost {
  state: CouncilAdapterState;
  progressLedger: CouncilProgressLedger;
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  swarmControl: SwarmControlCenter;
  stopAbortSignal: () => AbortSignal | undefined;
  closingRequested: () => boolean;
  setPhase: (phase: string) => void;
  appendSystem: (msg: string, summary?: unknown) => void;
  postCouncilTodo: (input: PostTodoInput) => string;
  evaluateCouncilStallGate: (
    planner: Agent,
    providerStall: string | null | undefined,
  ) => Promise<StallGateVerdict | null | undefined>;
  getBrainService?: () =>
    | { injectSuggestion?: (runId: string, s: { title: string; text: string; category?: string }) => void }
    | null
    | undefined;
  getActiveRunId: () => string | undefined;
  maxTiers: number;
  // Mutable counters (shared with runner)
  getStuckCycleCount: () => number;
  setStuckCycleCount: (n: number) => void;
  getPreviousUnmetIds: () => Set<string>;
  setPreviousUnmetIds: (s: Set<string>) => void;
  getPreviousStuckFailSignature: () => string;
  setPreviousStuckFailSignature: (s: string) => void;
  getConsecutiveEmptyCycles: () => number;
  setConsecutiveEmptyCycles: (n: number) => void;
  getTierPromotionRetries: () => number;
  setTierPromotionRetries: (n: number) => void;
  getStretchWaves: () => number;
  setStretchWaves: (n: number) => void;
  getCriterionProgressWaves: () => number;
  setCriterionProgressWaves: (n: number) => void;
  getZeroProgressStreak: () => number;
  setZeroProgressStreak: (n: number) => void;
  setEarlyStopDetail: (s: string) => void;
  logDiag?: (entry: unknown) => void;
}

/**
 * Open-ended stretch work after all-met / empty planner.
 * Prefer unmet-criterion files when present (progressive), else committed docs.
 */
function enqueueStretchTodos(
  host: CouncilAuditHost,
  cfg: RunConfig,
  cycle: number,
  reason: string,
): number {
  if (host.getStretchWaves() >= MAX_STRETCH_WAVES_PER_RUN) {
    host.appendSystem(
      `[ambition] Stretch wave cap reached (${MAX_STRETCH_WAVES_PER_RUN}/run) — not enqueueing more open-ended work.`,
    );
    return 0;
  }
  const directive = (cfg.userDirective ?? "").trim() || "the user directive";
  const unmet = host.state.contract?.criteria.filter((c) => c.status === "unmet") ?? [];
  const criterionFiles = unmet
    .flatMap((c) => c.expectedFiles ?? [])
    .map((f) => f.replace(/\\/g, "/"))
    .filter(Boolean);
  const committedDocs = host.state.committedFiles
    .filter((f) => /\.(md|txt|rst|html?|js|ts|tsx)$/i.test(f) || f.startsWith("docs/"))
    .slice(0, 8);
  // Prefer live criterion targets over generic README stretch (120b2044).
  const grounded =
    criterionFiles.length > 0
      ? [...new Set(criterionFiles)].slice(0, 6)
      : committedDocs.length > 0
        ? committedDocs
        : ["README.md"];

  const todos =
    unmet.length > 0 && criterionFiles.length > 0
      ? [
          {
            description:
              `Advance remaining unmet criteria for: ${directive.slice(0, 180)}. ` +
              `Focus on: ${unmet
                .slice(0, 3)
                .map((c) => c.description.slice(0, 80))
                .join(" · ")}. ` +
              `Make concrete file edits (expand tabs/content, fix gaps) in the listed targets.`,
            expectedFiles: grounded.slice(0, 3),
            createdBy: "stretch-unmet-criteria",
          },
          {
            description:
              `Close the next highest-value gap among unmet criteria (${unmet.length} still open). ` +
              `Prefer files that already exist; land a verifiable improvement this turn.`,
            expectedFiles: grounded.slice(0, 3),
            createdBy: "stretch-unmet-next",
          },
        ]
      : [
          {
            description:
              `Deepen research and documentation for: ${directive.slice(0, 200)}. ` +
              `Edit existing docs only; add citable findings and close remaining gaps.`,
            expectedFiles: grounded.slice(0, 3),
            createdBy: "stretch-research",
          },
          {
            description:
              `Consolidate, deduplicate, and improve structure of docs produced so far for: ${directive.slice(0, 160)}.`,
            expectedFiles: grounded.slice(0, 3),
            createdBy: "stretch-consolidate",
          },
        ];
  const n = postCouncilTodoBatch(
    (input) => host.postCouncilTodo(input),
    todos,
    (msg) => host.appendSystem(msg),
  );
  if (n > 0) {
    host.setStretchWaves(host.getStretchWaves() + 1);
  }
  host.logDiag?.({
    type: "council_stretch_todos",
    runId: host.getActiveRunId() || cfg.runId,
    cycle,
    reason,
    enqueued: n,
    wave: host.getStretchWaves(),
  });
  return n;
}

/**
 * Deterministic criterion-progress wave: mint grounded todos from unmet
 * criteria when LLM audit/planner invent nothing. Progressive recovery for
 * long autonomous runs (stopDetail "planner-fallback: no todos…" on 120b2044).
 */
function enqueueCriterionProgressTodos(
  host: CouncilAuditHost,
  cfg: RunConfig,
  cycle: number,
  unmetCriteria: ReadonlyArray<{ id?: string; description: string; expectedFiles: string[] }>,
): number {
  if (host.getCriterionProgressWaves() >= MAX_CRITERION_PROGRESS_WAVES_PER_RUN) {
    host.appendSystem(
      `[ambition] Criterion-progress wave cap reached (${MAX_CRITERION_PROGRESS_WAVES_PER_RUN}/run).`,
    );
    return 0;
  }
  // Avoid re-seeding any shape already on the board (any status).
  const avoid = new Set<string>();
  for (const t of host.state.todoQueue.list()) {
    avoid.add(todoProgressSignature(t.description, t.expectedFiles ?? []));
  }
  const fallbackFiles = host.state.committedFiles
    .filter((f) => /\.(html?|js|ts|md)$/i.test(f))
    .slice(0, 4);
  const minted = mintProgressTodosFromUnmetCriteria(unmetCriteria, {
    maxTodos: 8,
    avoidSignatures: avoid,
    fallbackFiles,
  });
  if (minted.length === 0) return 0;
  const n = postCouncilTodoBatch(
    (input) => host.postCouncilTodo(input),
    minted.map((t) => ({
      description: t.description,
      expectedFiles: t.expectedFiles,
      createdBy: t.createdBy,
      ...(t.criterionId ? { criterionId: t.criterionId } : {}),
    })),
    (msg) => host.appendSystem(msg),
  );
  if (n > 0) {
    host.setCriterionProgressWaves(host.getCriterionProgressWaves() + 1);
    host.appendSystem(
      `[ambition] Criterion-progress wave ${host.getCriterionProgressWaves()}/${MAX_CRITERION_PROGRESS_WAVES_PER_RUN}: ` +
        `seeded ${n} grounded todo(s) from unmet criteria — continuing autonomously.`,
    );
  }
  host.logDiag?.({
    type: "council_criterion_progress_todos",
    runId: host.getActiveRunId() || cfg.runId,
    cycle,
    enqueued: n,
    wave: host.getCriterionProgressWaves(),
  });
  return n;
}

export async function runCouncilAuditCycle(
  host: CouncilAuditHost,
  cfg: RunConfig,
  cycle: number,
): Promise<"done" | "retry" | "stop"> {
  if (!host.state.contract) return "done";
  if (host.closingRequested()) return "stop";
  // Match CouncilRunner.loop: rounds=0 or continuous (startRoute rewrite ~1e6).
  const isAutonomous = cfg.rounds === 0 || cfg.rounds >= 1_000_000;

  host.setPhase("auditing");

  const tagAudit = (msg: string) => {
    if (msg.startsWith("[audit] LLM audit:")) {
      host.appendSystem(msg, {
        kind: "council_stage",
        cycle,
        stage: "audit",
        detail: msg.replace(/^\[audit\]\s*/, ""),
      });
    } else {
      host.appendSystem(msg);
    }
  };

  const skipEvidence = host.state.todoQueue
    .list()
    .filter((t) => t.status === "skipped" && t.reason)
    .map((t) => ({
      criterionId: t.criterionId,
      criteriaIds: t.criteriaIds,
      reason: t.reason,
      expectedFiles: t.expectedFiles,
    }));

  /** Permanent-skips (attempts exhausted / noop) — suppress audit re-mint of same shape. */
  const permanentSkipEvidence = host.state.todoQueue
    .list()
    .filter((t) => t.status === "skipped" && isPermanentSkipReason(t.reason))
    .map((t) => ({
      description: t.description,
      expectedFiles: t.expectedFiles,
      reason: t.reason,
      criterionId: t.criterionId,
      criteriaIds: t.criteriaIds,
    }));

  const criteriaBeforeAudit = host.state.contract.criteria;
  const { criteria: ledgerReconciled, promotedIds: ledgerPromoted } = reconcileCriteriaFromLedger(
    host.progressLedger,
    criteriaBeforeAudit,
    host.state.committedFiles,
  );
  if (ledgerPromoted.length > 0) {
    host.state.contract = { ...host.state.contract, criteria: ledgerReconciled };
    host.appendSystem(
      `[execution] Promoted ${ledgerPromoted.length} criterion(s) to met from ledger commits: ${ledgerPromoted.join(", ")}.`,
    );
  }

  const { updatedCriteria, newTodos } = await runCouncilLlmAudit(
    cfg,
    host.state.contract,
    host.state.committedFiles,
    {
      manager: host.manager as any,
      appendSystem: tagAudit,
      stopping: () => host.closingRequested(),
      abortSignal: host.stopAbortSignal(),
      ledger: host.progressLedger,
      getSwarmControl: () => host.swarmControl,
      getCoachAgent: () => host.manager.list().find((a) => a.index === 1),
      emit: (e) => host.emit(e as SwarmEvent),
    },
    skipEvidence,
    permanentSkipEvidence,
  );

  if (host.closingRequested()) return "stop";

  host.state.contract = { ...host.state.contract, criteria: updatedCriteria };
  const unmetCount = updatedCriteria.filter((c) => c.status === "unmet").length;
  const currentUnmetIds = new Set(
    updatedCriteria.filter((c) => c.status === "unmet").map((c) => c.id),
  );

  const beforeById = new Map(criteriaBeforeAudit.map((c) => [c.id, c]));
  const metFlipIds = updatedCriteria
    .filter(
      (c) =>
        c.status === "met"
        && beforeById.get(c.id)?.status === "unmet"
        && !ledgerPromoted.includes(c.id),
    )
    .map((c) => c.id);
  const metFlips = metFlipIds.length;
  // Met flips the auditor likely rubber-stamped from skip evidence alone
  // are non-durable without a commit (disk may still be wrong).
  const skipCoveredCriterionIds = new Set<string>();
  for (const e of skipEvidence) {
    if (e.criterionId) skipCoveredCriterionIds.add(e.criterionId);
    if (Array.isArray(e.criteriaIds)) {
      for (const id of e.criteriaIds) {
        if (id) skipCoveredCriterionIds.add(id);
      }
    }
  }
  const skipOnlyMetFlips = metFlipIds.filter((id) =>
    skipCoveredCriterionIds.has(id),
  ).length;

  const sameUnmet = [...currentUnmetIds].filter((id) => host.getPreviousUnmetIds().has(id)).length;
  const failSignature = buildUnmetFailSignature(
    host.progressLedger,
    currentUnmetIds,
    updatedCriteria,
    cycle,
  );
  const commitOnUnmet = hasCommitProgressOnUnmet(
    host.progressLedger,
    currentUnmetIds,
    updatedCriteria,
    cycle,
  );
  const sameFailurePattern =
    failSignature.length > 0 && failSignature === host.getPreviousStuckFailSignature();

  host.setPreviousUnmetIds(currentUnmetIds);
  host.setPreviousStuckFailSignature(failSignature);

  const commitsThisCycle = host.progressLedger.observations.filter(
    (o) => o.kind === "commit" && o.cycle === cycle,
  ).length;

  /**
   * Autonomous: stop after N cycles without *durable* progress
   * (commits / durable met flips / tier promotion). New todos alone
   * no longer reset the streak (prevents stretch/audit spin).
   */
  const maybeStopNoProgress = (
    signals: {
      metFlips: number;
      commitsThisCycle: number;
      newTodos: number;
      tierPromoted?: boolean;
      skipOnlyMetFlips?: number;
    },
  ): "stop" | null => {
    if (!isAutonomous) {
      if (isDurableProgress(signals)) host.setZeroProgressStreak(0);
      return null;
    }
    const durable = isDurableProgress(signals);
    const { streak, shouldStop } = updateZeroProgressStreak(
      host.getZeroProgressStreak(),
      durable,
      DEFAULT_ZERO_PROGRESS_LIMIT,
    );
    host.setZeroProgressStreak(streak);
    if (!shouldStop) {
      if (streak > 0) {
        host.appendSystem(
          `[audit] Zero durable progress streak ${streak}/${DEFAULT_ZERO_PROGRESS_LIMIT}`
            + ` (commits+${signals.commitsThisCycle}, met+${signals.metFlips}`
            + `, todos+${signals.newTodos}${signals.tierPromoted ? ", tier↑" : ""}).`,
        );
      }
      return null;
    }
    const reason = formatNoProductiveProgressReason(streak);
    host.setEarlyStopDetail(reason);
    host.appendSystem(`[audit] ${reason} — stopping autonomous run.`);
    host.logDiag?.({
      type: "council_stop_reason",
      runId: host.getActiveRunId() || cfg.runId,
      cycle,
      reason,
    });
    host.setPhase("stopped");
    void notifyGuardTrip({
      kind: "audit-stuck",
      detail: reason,
      runId: host.getActiveRunId() || undefined,
      appendSystem: (t, s) => host.appendSystem(t, s),
      getBrainService: host.getBrainService,
    });
    return "stop";
  };

  if (unmetCount > 0 && sameUnmet === currentUnmetIds.size) {
    const noLedgerProgress = sameFailurePattern && !commitOnUnmet && metFlips === 0;
    if (noLedgerProgress) {
      const transientOnly = unmetFailsAreTransientOnly(
        host.progressLedger,
        currentUnmetIds,
        updatedCriteria,
        cycle,
      );
      if (transientOnly) {
        host.setStuckCycleCount(0);
        host.setPreviousStuckFailSignature("");
        if (isAutonomous) {
          host.appendSystem(
            "[audit] Provider quota/transport stall — backing off 2m without counting as stuck.",
          );
          await new Promise((r) => setTimeout(r, 120_000));
          return "retry";
        }
        host.setEarlyStopDetail(
          "provider-quota: unmet criteria after transport/429 stalls (not a code deadlock)",
        );
        host.appendSystem(
          "[audit] Provider quota/transport stall on finite-round run — stopping with provider-quota (not audit-stuck).",
        );
        host.setPhase("stopped");
        return "stop";
      }
      const providerStall = extractRecentProviderStallFromLedger(host.progressLedger, cycle);
      const planner = host.manager.list().find((a) => a.index === 1);
      if (planner) {
        const gate = await host.evaluateCouncilStallGate(planner, providerStall);
        if (gate?.action === "backoff") {
          host.setStuckCycleCount(0);
          host.setPreviousStuckFailSignature("");
          if (isAutonomous) {
            const waitMs = gate.backoffMs ?? 120_000;
            host.appendSystem(
              `[control] Backing off ${Math.round(waitMs / 1000)}s — ${gate.rationale}`,
            );
            await new Promise((r) => setTimeout(r, waitMs));
            return "retry";
          }
          host.setEarlyStopDetail(`provider-quota: ${gate.rationale}`);
          host.appendSystem(`[control] Finite-round run — ${gate.rationale} (stop, not stuck).`);
          host.setPhase("stopped");
          return "stop";
        }
        // Honor retry on finite-round runs too (align with blackboard tierRunner).
        // PlannerHint is already applied via session control; one more cycle is cheap
        // vs burning stuck counters while ignoring control advice.
        if (gate?.action === "retry") {
          host.setStuckCycleCount(0);
          host.setPreviousStuckFailSignature("");
          host.appendSystem(`[control] Retrying after stall gate — ${gate.rationale}`);
          return "retry";
        }
        if (gate?.action === "stop") {
          host.setEarlyStopDetail(`audit-stuck: ${gate.rationale}`);
          host.appendSystem(`[control] Stopping — ${gate.rationale}`);
          host.setPhase("stopped");
          return "stop";
        }
      }
      if (providerStall && /429|session usage|rate limit/i.test(providerStall)) {
        host.appendSystem(
          "[audit] Recent provider stall is quota/429 — not incrementing stuck cycle counter.",
        );
        return "retry";
      }
      const stuck = host.getStuckCycleCount() + 1;
      host.setStuckCycleCount(stuck);
      host.appendSystem(`[audit] Same ${sameUnmet} criteria unmet for ${stuck} cycle(s).`);
      if (stuck >= 3) {
        const reason = `audit-stuck: same ${sameUnmet} criteria unmet for ${stuck} cycles`;
        host.setEarlyStopDetail(reason);
        host.appendSystem(`[audit] Stuck for ${stuck} cycles — stopping.`);
        host.logDiag?.({
          type: "council_stop_reason",
          runId: host.getActiveRunId() || cfg.runId,
          cycle,
          reason,
        });
        host.setPhase("stopped");
        notifyGuardTrip({
          kind: "audit-stuck",
          detail: `same ${sameUnmet} criteria unmet for ${stuck} cycles`,
          runId: host.getActiveRunId() || undefined,
          appendSystem: (t, s) => host.appendSystem(t, s),
          getBrainService: host.getBrainService,
        });
        return "stop";
      }
    } else {
      host.setStuckCycleCount(0);
    }
  } else {
    host.setStuckCycleCount(0);
    host.setPreviousStuckFailSignature("");
  }

  if (unmetCount === 0) {
    host.setStuckCycleCount(0);
    host.setPreviousUnmetIds(new Set());
    host.setConsecutiveEmptyCycles(0);

    const planner = host.manager.list().find((a) => a.index === 1);
    if (planner && host.state.currentTier < host.maxTiers) {
      host.appendSystem(
        `[ambition] All criteria met — attempting tier ${host.state.currentTier + 1} promotion.`,
      );
      host.logDiag?.({
        type: "council_stop_progress",
        runId: host.getActiveRunId?.() ?? cfg.runId,
        cycle,
        kind: "ambition-tier-up-start",
        tier: host.state.currentTier + 1,
      });
      // Belt-and-suspenders: never let tier promotion throw end the process
      // (run 961a885f stopReason crash on think-only format sniff).
      let promoted = false;
      try {
        promoted = await runTierPromotion(host.state, planner, host.maxTiers);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        host.appendSystem(
          `[ambition] Tier promotion threw (${msg.slice(0, 160)}) — counting as failed attempt.`,
        );
        promoted = false;
      }
      if (promoted) {
        host.setTierPromotionRetries(0);
        host.appendSystem(
          `[ambition] Tier ${host.state.currentTier} installed — continuing next cycle (standup + research + execute).`,
        );
        host.logDiag?.({
          type: "council_stop_progress",
          runId: host.getActiveRunId?.() ?? cfg.runId,
          cycle,
          kind: "ambition-tier-up-ok",
          tier: host.state.currentTier,
          criteria: host.state.contract?.criteria.length,
        });
        // Must be "retry" (not "done"): the outer CouncilRunner loop treats
        // "done" as terminal for non-autonomous runs (rounds > 0). Ambition
        // ratchet always needs another cycle to execute the new tier's
        // unmet criteria — including when the user set rounds=0 and when
        // they set a finite rounds cap that still allows multi-cycle work.
        host.setZeroProgressStreak(0);
        return "retry";
      }
      const retries = host.getTierPromotionRetries() + 1;
      host.setTierPromotionRetries(retries);
      if (retries >= 3) {
        // Prefer one stretch wave over hard stop on autonomous runs.
        // Stretch does NOT reset the durable-progress streak.
        if (isAutonomous) {
          const stretch = enqueueStretchTodos(host, cfg, cycle, "ambition-promotion-failed");
          if (stretch > 0) {
            host.appendSystem(
              `[ambition] Tier promotion failed ${retries} times — enqueued ${stretch} stretch todo(s); continuing.`,
            );
            host.setTierPromotionRetries(0);
            return "retry";
          }
        }
        const reason = `ambition-failed: tier promotion failed ${retries} times`;
        host.setEarlyStopDetail(reason);
        host.appendSystem(`[ambition] Tier promotion failed ${retries} times — stopping.`);
        host.logDiag?.({
          type: "council_stop_reason",
          runId: host.getActiveRunId() || cfg.runId,
          cycle,
          reason,
        });
        host.setPhase("stopped");
        return "stop";
      }
      host.appendSystem(
        `[ambition] Tier promotion returned no criteria — retrying (${retries}/3).`,
      );
      return "retry";
    }
    if (isAutonomous) {
      const stretch = enqueueStretchTodos(host, cfg, cycle, "all-criteria-met-open-research");
      if (stretch > 0) {
        host.appendSystem(
          `[ambition] All criteria met (no further tiers) — enqueued ${stretch} stretch todo(s) for open-ended directive; continuing.`,
        );
        // Do not reset zero-progress streak — stretch alone is not durable progress.
        return "retry";
      }
    }
    const doneReason = "ambition-complete: all criteria met, no further tiers";
    host.appendSystem(`[ambition] All criteria met, no more tiers — stopping.`);
    host.setEarlyStopDetail(doneReason);
    host.logDiag?.({
      type: "council_stop_reason",
      runId: host.getActiveRunId() || cfg.runId,
      cycle,
      reason: doneReason,
    });
    return "stop";
  }

  // Drop todos that rehash prior DENY deliberation patterns (skipped in autoApprove).
  let auditTodos = newTodos;
  if (!cfg.autoApprove) {
    try {
      const { buildDeliberationSeed, filterTodosAgainstDeliberationDenies } = await import(
        "./deliberation/deliberationSeed.js"
      );
      const delibSeed = await buildDeliberationSeed(cfg.localPath ?? "");
      if (delibSeed.denyPatterns.length > 0) {
        const { kept, dropped } = filterTodosAgainstDeliberationDenies(
          newTodos,
          delibSeed.denyPatterns,
        );
        if (dropped.length > 0) {
          host.appendSystem(
            `[deliberation] Dropped ${dropped.length} audit todo(s) matching prior DENY patterns.`,
          );
          auditTodos = kept;
        }
      }
    } catch {
      /* best-effort */
    }
  }

  // Run 2964afe8: after permanent-skip of create-test class, audit re-minted
  // identical "Create Vitest…" todos → cycles 7–8 zero progress. Suppress unless
  // this cycle already made durable progress (commits / met flips).
  {
    const hadDurable =
      commitsThisCycle > 0 || metFlips > 0 || ledgerPromoted.length > 0;
    const { kept, dropped } = filterAuditTodosAgainstPermanentSkips(
      auditTodos,
      permanentSkipEvidence,
      { hadDurableProgress: hadDurable },
    );
    if (dropped.length > 0) {
      host.appendSystem(
        `[audit] Dropped ${dropped.length} todo(s) re-minting permanent-skipped create/author shapes ` +
          `(no durable progress this cycle).`,
      );
      auditTodos = kept;
    }
  }

  const auditEnqueued = postCouncilTodoBatch(
    (input) => host.postCouncilTodo(input),
    auditTodos.map((t) => ({
      description: t.description,
      expectedFiles: t.expectedFiles,
      createdBy: "auditor",
      ...(t.criterionId ? { criterionId: t.criterionId } : {}),
    })),
    (msg) => host.appendSystem(msg),
  );
  host.appendSystem(`[audit] Created ${auditEnqueued} todo(s) for unmet criteria.`);

  if (auditTodos.length === 0) {
    // No new work — may still stop autonomous on zero-progress streak.
    const empty = host.getConsecutiveEmptyCycles() + 1;
    host.setConsecutiveEmptyCycles(empty);
    if (empty >= 2) {
      host.appendSystem(
        `[audit] No new todos for ${empty} cycles — trying planner fallback.`,
      );
      const lead = host.manager.list().find((a) => a.index === 1);
      if (lead) {
        const unmetCriteria =
          host.state.contract?.criteria.filter((c) => c.status === "unmet") ?? [];
        if (unmetCriteria.length > 0) {
          const { buildAuditorUnmetTodoFallbackPrompt } = await import(
            "./councilDecisions.js"
          );
          const prompt = buildAuditorUnmetTodoFallbackPrompt(unmetCriteria, {
            directive: cfg.userDirective,
            committedFiles: host.state.committedFiles,
          });

          try {
            const { controller, cleanup } = createTimeoutController();
            try {
              const raw = await promptWithFailoverAuto(
                lead,
                prompt,
                {
                  manager: host.manager,
                  agentName: resolveCouncilToolProfile(cfg),
                  webToolsConfig: cfg,
                  signal: controller.signal,
                  activity: { kind: "council", label: "planner fallback todos" },
                },
                cfg.providerFailover,
              );
              const text = extractProviderText(raw);
              if (text) {
                const todos = parseJsonArrayFromResponse(
                  text,
                  (t: Record<string, unknown>, i: number) => ({
                    description: String(t.description ?? `Task ${i + 1}`),
                    expectedFiles: Array.isArray(t.expectedFiles)
                      ? t.expectedFiles.map(String)
                      : [],
                  }),
                );
                const fallbackEnqueued = postCouncilTodoBatch(
                  (input) => host.postCouncilTodo(input),
                  todos.map((t) => ({
                    description: t.description,
                    expectedFiles: t.expectedFiles,
                    createdBy: "planner-fallback",
                  })),
                  (msg) => host.appendSystem(msg),
                );
                host.appendSystem(`[planner] Fallback created ${fallbackEnqueued} todo(s).`);
                if (fallbackEnqueued > 0) {
                  cleanup();
                  // Todos alone are not durable progress; streak continues.
                  return "retry";
                }
              }
            } finally {
              cleanup();
            }
          } catch {
            /* ignore */
          }
        }
        if (isAutonomous) {
          const stretch = enqueueStretchTodos(host, cfg, cycle, "planner-fallback-empty");
          if (stretch > 0) {
            host.appendSystem(
              `[planner] Fallback produced nothing — enqueued ${stretch} stretch todo(s); continuing autonomous.`,
            );
            host.setConsecutiveEmptyCycles(0);
            return "retry";
          }
          // Progressive: seed todos directly from unmet criteria (no LLM required).
          if (unmetCriteria.length > 0) {
            const progressN = enqueueCriterionProgressTodos(
              host,
              cfg,
              cycle,
              unmetCriteria.map((c) => ({
                id: (c as { id?: string }).id,
                description: c.description,
                expectedFiles: c.expectedFiles ?? [],
              })),
            );
            if (progressN > 0) {
              host.setConsecutiveEmptyCycles(0);
              return "retry";
            }
          }
        }
        // Empty planner + empty stretch + empty criterion-progress:
        // only stop via durable-progress streak (do not hard-kill early while
        // wall-clock autonomous work may still resume next cycle).
        const emptyStop = maybeStopNoProgress({
          metFlips,
          commitsThisCycle,
          newTodos: 0,
          skipOnlyMetFlips,
        });
        if (emptyStop) return emptyStop;
        // Soft continue: log and retry once more paths can invent work next cycle,
        // unless empty streak is already high (5+) — then set early-stop.
        if (empty >= 5) {
          const reason = "planner-fallback: no todos for unmet criteria after progressive recovery";
          host.appendSystem(
            `[planner] Fallback + stretch + criterion-progress produced nothing after ${empty} empty cycles — stopping.`,
          );
          host.setEarlyStopDetail(reason);
          host.logDiag?.({
            type: "council_stop_reason",
            runId: host.getActiveRunId() || cfg.runId,
            cycle,
            reason,
          });
          return "stop";
        }
        host.appendSystem(
          `[planner] Fallback empty (empty-cycles=${empty}) — progressive recovery exhausted this cycle; retrying next cycle.`,
        );
        return "retry";
      }
    }
  } else {
    host.setConsecutiveEmptyCycles(0);
  }

  // Todos enqueued → retry, but only durable signals reset the streak.
  if (auditEnqueued > 0) {
    const todoOnlyStop = maybeStopNoProgress({
      metFlips,
      commitsThisCycle,
      newTodos: auditEnqueued,
      skipOnlyMetFlips,
    });
    if (todoOnlyStop) return todoOnlyStop;
    return "retry";
  }
  const noWorkStop = maybeStopNoProgress({
    metFlips,
    commitsThisCycle,
    newTodos: auditEnqueued,
    skipOnlyMetFlips,
  });
  if (noWorkStop) return noWorkStop;
  return "retry";
}
