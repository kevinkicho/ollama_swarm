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
  setEarlyStopDetail: (s: string) => void;
  logDiag?: (entry: unknown) => void;
}

/** Open-ended stretch work so autonomous runs continue after "all met". */
function enqueueStretchTodos(
  host: CouncilAuditHost,
  cfg: RunConfig,
  cycle: number,
  reason: string,
): number {
  const directive = (cfg.userDirective ?? "").trim() || "the user directive";
  const todos = [
    {
      description: `Deepen research and documentation for: ${directive.slice(0, 200)}. Add citable findings and close remaining gaps.`,
      expectedFiles: [] as string[],
      createdBy: "stretch-research",
    },
    {
      description: `Consolidate, deduplicate, and improve structure of docs produced so far for: ${directive.slice(0, 160)}.`,
      expectedFiles: [] as string[],
      createdBy: "stretch-consolidate",
    },
  ];
  const n = postCouncilTodoBatch(
    (input) => host.postCouncilTodo(input),
    todos,
    (msg) => host.appendSystem(msg),
  );
  host.logDiag?.({
    type: "council_stretch_todos",
    runId: host.getActiveRunId() || cfg.runId,
    cycle,
    reason,
    enqueued: n,
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
  );

  if (host.closingRequested()) return "stop";

  host.state.contract = { ...host.state.contract, criteria: updatedCriteria };
  const unmetCount = updatedCriteria.filter((c) => c.status === "unmet").length;
  const currentUnmetIds = new Set(
    updatedCriteria.filter((c) => c.status === "unmet").map((c) => c.id),
  );

  const beforeById = new Map(criteriaBeforeAudit.map((c) => [c.id, c]));
  const metFlips = updatedCriteria.filter(
    (c) =>
      c.status === "met"
      && beforeById.get(c.id)?.status === "unmet"
      && !ledgerPromoted.includes(c.id),
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
        if (gate?.action === "retry" && isAutonomous) {
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
        const { notifyGuardTrip } = await import("./guardNotify.js");
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
      const promoted = await runTierPromotion(host.state, planner, host.maxTiers);
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
        return "retry";
      }
      const retries = host.getTierPromotionRetries() + 1;
      host.setTierPromotionRetries(retries);
      if (retries >= 3) {
        // Prefer stretch work over hard stop on autonomous runs.
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

  const auditEnqueued = postCouncilTodoBatch(
    (input) => host.postCouncilTodo(input),
    newTodos.map((t) => ({
      description: t.description,
      expectedFiles: t.expectedFiles,
      createdBy: "auditor",
      ...(t.criterionId ? { criterionId: t.criterionId } : {}),
    })),
    (msg) => host.appendSystem(msg),
  );
  host.appendSystem(`[audit] Created ${auditEnqueued} todo(s) for unmet criteria.`);

  if (newTodos.length === 0) {
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
          const prompt = `You are the planner. The auditor found ${unmetCriteria.length} unmet criteria:

${unmetCriteria.map((c) => `- ${c.description} (files: ${c.expectedFiles.join(", ") || "none"})`).join("\n")}

Your task: For EACH unmet criterion, produce 1-2 concrete, actionable todos that would satisfy it.
Each todo must have a specific description and list the files it would modify.

Output a JSON array:
[{"description": "specific change", "expectedFiles": ["path/to/file.ts"]}]

Max 8 todos. Every file path MUST appear in the PROJECT FILES list.`;

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
        }
        const reason = "planner-fallback: no todos for unmet criteria";
        host.appendSystem(`[planner] Fallback produced nothing — stopping.`);
        host.setEarlyStopDetail(reason);
        host.logDiag?.({
          type: "council_stop_reason",
          runId: host.getActiveRunId() || cfg.runId,
          cycle,
          reason,
        });
        return "stop";
      }
    }
  } else {
    host.setConsecutiveEmptyCycles(0);
  }

  return "retry";
}
