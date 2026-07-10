// Orchestrator-worker-deep cycle loop body — extracted from OrchestratorWorkerDeepRunner.loop.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { notifyGuardTrip } from "./guardNotify.js";
import { staggerStart } from "./staggerStart.js";
import {
  buildTopPlanPrompt,
  buildTopSynthesisPrompt,
  buildOrchestratorReplanPrompt,
} from "./orchestratorWorkerDeepPromptHelpers.js";
import {
  parsePlan,
  type Assignment,
} from "./orchestratorWorkerPromptHelpers.js";
import type { DeepTopology } from "./orchestratorWorkerDeepTopology.js";

export interface OwDeepLoopHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  topology: DeepTopology | null;
  getCyclePushbacks: () => Map<number, string>;
  setCyclePushbacks: (m: Map<number, string>) => void;
  getStopping: () => boolean;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runAgent: (agent: Agent, prompt: string) => Promise<string>;
  runMidLeadSubtree: (
    midLead: Agent,
    pool: Agent[],
    coarseAssignment: Assignment,
    round: number,
    totalRounds: number,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ) => Promise<void>;
  getRunId?: () => string | undefined;
  getBrainService?: () =>
    | { injectSuggestion?: (runId: string, s: { title: string; text: string; category?: string }) => void }
    | null
    | undefined;
}

export async function runOwDeepLoopBody(
  host: OwDeepLoopHost,
  cfg: RunConfig,
): Promise<void> {
    const t = host.topology!;
    const allAgents = host.manager.list();
    const orchestrator = allAgents.find((a) => a.index === t.orchestratorIndex);
    const midLeads = t.midLeadIndices
      .map((idx) => allAgents.find((a) => a.index === idx))
      .filter((a): a is Agent => a !== undefined);
    if (!orchestrator) throw new Error(`orchestrator agent (index ${t.orchestratorIndex}) did not spawn`);
    if (midLeads.length === 0) throw new Error("no mid-leads spawned");

    // Per-mid-lead worker pool, resolved once.
    const workerPools: Agent[][] = t.workerByMidLead.map((indices) =>
      indices
        .map((idx) => allAgents.find((a) => a.index === idx))
        .filter((a): a is Agent => a !== undefined),
    );
    // A mid-lead with zero spawned workers is dead weight; drop it from
    // this run rather than dispatching empty cycles.
    const liveMidLeads: Agent[] = [];
    const liveWorkerPools: Agent[][] = [];
    for (let i = 0; i < midLeads.length; i++) {
      if (workerPools[i]!.length > 0) {
        liveMidLeads.push(midLeads[i]!);
        liveWorkerPools.push(workerPools[i]!);
      }
    }
    if (liveMidLeads.length === 0) {
      throw new Error("no mid-leads with at least 1 worker — topology degenerate");
    }

    // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
    const tokenBaseline = snapshotLifetimeTokens();
    const planEmptyGuard = new PlanEmptyDeadLoopGuard({
      roleLabel: "orchestrator",
    });

    for (let r = 1; r <= cfg.rounds; r++) {
      if (!host.checkRoundBudget(cfg, "cycle", r, tokenBaseline)) break;

      // Phase 1 — TOP-PLAN
      host.appendSystem(`Cycle ${r}/${cfg.rounds}: orchestrator planning at top level.`);
      const topPlanText = await host.runAgent(
        orchestrator,
        buildTopPlanPrompt(r, cfg.rounds, liveMidLeads.map((m) => m.index), [...host.transcript], cfg.userDirective),
      );
      if (host.getStopping()) break;
      const topPlan = parsePlan(topPlanText, liveMidLeads.map((m) => m.index));
      if (topPlan.done === true && r > 1) {
        host.setEarlyStopDetail(`orchestrator-reports-done after cycle ${r}/${cfg.rounds}`);
        host.appendSystem(
          `Orchestrator reports done — ending OW-deep early at cycle ${r}/${cfg.rounds}.`,
        );
        break;
      }

      // 2026-05-06: retry once when the orchestrator produces no parseable
      // assignments, with an explicit format reminder. Same pattern as OW.
      let finalTopPlan = topPlan;
      if (topPlan.assignments.length === 0 && topPlanText.length > 20) {
        host.appendSystem(
          `Cycle ${r}: orchestrator output was not valid JSON assignments — retrying with format reminder.`,
        );
        const retryPrompt = buildTopPlanPrompt(r, cfg.rounds, liveMidLeads.map((m) => m.index), [...host.transcript], cfg.userDirective)
          + "\n\nIMPORTANT: Your response MUST contain a ```json code block with an \"assignments\" array. For example:\n```json\n{\n  \"assignments\": [\n    {\"agentIndex\": 2, \"subtask\": \"...\", \"successCriteria\": \"...\"},\n    {\"agentIndex\": 3, \"subtask\": \"...\", \"successCriteria\": \"...\"}\n  ]\n}\n```\nDo NOT just explore the repo — you MUST output the JSON block.";
        const retryText = await host.runAgent(orchestrator, retryPrompt);
        if (!host.getStopping()) {
          const retryPlan = parsePlan(retryText, liveMidLeads.map((m) => m.index));
          if (retryPlan.assignments.length > 0) {
            finalTopPlan = retryPlan;
            host.appendSystem(`Cycle ${r}: retry succeeded — got ${retryPlan.assignments.length} assignments.`);
          }
        }
      }

      // 2026-05-03 (Phase B): plan-empty guard extracted to shared class.
      const planHit = planEmptyGuard.recordCycle(finalTopPlan.assignments);
      if (finalTopPlan.assignments.length === 0) {
        host.appendSystem(
          `Cycle ${r}: orchestrator produced no parseable mid-lead assignments — skipping execute phase this cycle. (consecutive=${planHit.consecutive})`,
        );
        if (planHit.tripped) {
          host.setEarlyStopDetail(planHit.earlyStopDetail);
          host.appendSystem(
            `Orchestrator has produced empty plans for ${planHit.consecutive} consecutive cycles — ending OW-deep early to avoid burning wall-clock on dead loops.`,
          );
          notifyGuardTrip({
            kind: "plan-empty",
            detail: planHit.earlyStopDetail ?? "orchestrator-empty-plans",
            runId: host.getRunId?.() ?? cfg.runId,
            appendSystem: (t) => host.appendSystem(t),
            getBrainService: host.getBrainService,
          });
          break;
        }
        continue;
      }
      // Counter resets automatically inside recordCycle when assignments.length > 0.

      // Phase 2 + 3 + 4 — Each mid-lead, in parallel: plan → workers → synth.
      // The seed snapshot all sub-prompts share is the system messages
      // captured BEFORE this cycle's per-mid-lead activity.
      const seedSnapshot = host.transcript.filter((e) => e.role === "system");
      // T199 (2026-05-04): clear cycle's pushback tracker before the
      // mid-lead subtrees populate it.
      host.setCyclePushbacks(new Map());
      await staggerStart(finalTopPlan.assignments, async (a) => {
        const midLeadIdx = a.agentIndex;
        const midLeadPos = liveMidLeads.findIndex((m) => m.index === midLeadIdx);
        if (midLeadPos < 0) return;
        const midLead = liveMidLeads[midLeadPos]!;
        const pool = liveWorkerPools[midLeadPos]!;
        await host.runMidLeadSubtree(midLead, pool, a, r, cfg.rounds, seedSnapshot, cfg.userDirective);
      });
      if (host.getStopping()) break;

      // T199 (2026-05-04): bidirectional refinement auto-replan.
      // After mid-leads run, if cfg.bidirectionalRefinement is set
      // AND any mid-lead pushed back, fire ONE orchestrator-level
      // replan that sees the pushbacks + dispatches a corrected
      // mini-cycle. Capped at 1 replan per cycle to bound runtime.
      if (
        cfg.bidirectionalRefinement &&
        host.getCyclePushbacks().size > 0 &&
        !host.getStopping()
      ) {
        const pushbacks = host.getCyclePushbacks();
        const pbSummary = [...pushbacks.entries()]
          .map(([idx, pb]) => `Mid-lead ${idx}: ${pb}`)
          .join("\n  ");
        host.appendSystem(
          `[T199 bidirectional refinement] ${pushbacks.size} mid-lead(s) pushed back; firing orchestrator REPLAN.\n  ${pbSummary}`,
        );
        const replanPrompt = buildOrchestratorReplanPrompt({
          originalPlan: finalTopPlan,
          pushbacks,
          availableMidLeadIndices: liveMidLeads.map((m) => m.index),
          round: r,
          totalRounds: cfg.rounds,
          userDirective: cfg.userDirective,
        });
        const replanText = await host.runAgent(orchestrator, replanPrompt);
        if (!host.getStopping()) {
          const replan = parsePlan(replanText, liveMidLeads.map((m) => m.index));
          if (replan.assignments.length > 0) {
            host.appendSystem(
              `[T199 bidirectional refinement] orchestrator emitted ${replan.assignments.length} revised assignment(s); dispatching refinement wave.`,
            );
            host.setCyclePushbacks(new Map()); // clear so the refinement wave doesn't re-trigger
            await staggerStart(replan.assignments, async (a) => {
              const midLeadIdx = a.agentIndex;
              const midLeadPos = liveMidLeads.findIndex((m) => m.index === midLeadIdx);
              if (midLeadPos < 0) return;
              const midLead = liveMidLeads[midLeadPos]!;
              const pool = liveWorkerPools[midLeadPos]!;
              await host.runMidLeadSubtree(midLead, pool, a, r, cfg.rounds, seedSnapshot, cfg.userDirective);
            });
          } else {
            host.appendSystem(
              `[T199 bidirectional refinement] orchestrator's replan parsed empty — proceeding to synthesis with the original wave's outputs.`,
            );
          }
        }
      }
      if (host.getStopping()) break;

      // Phase 5 — TOP-SYNTH
      host.appendSystem(`Cycle ${r}/${cfg.rounds}: orchestrator synthesizing across mid-lead reports.`);
      await host.runAgent(
        orchestrator,
        buildTopSynthesisPrompt(r, cfg.rounds, [...host.transcript], cfg.userDirective),
      );
    }
    if (!host.getStopping()) host.appendSystem("Orchestrator-worker-deep run complete.");
}
