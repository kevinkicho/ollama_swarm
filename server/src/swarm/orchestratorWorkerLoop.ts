// Orchestrator-worker cycle loop body — extracted from OrchestratorWorkerRunner.loop.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { staggerStart } from "./staggerStart.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import {
  buildLeadPlanPrompt,
  buildLeadSynthesisPrompt,
  parsePlan,
  summarizeEffortDistribution,
} from "./orchestratorWorkerPromptHelpers.js";
import type { Plan } from "./orchestratorWorkerPromptHelpers.js";

export interface OwLoopHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  stats: any;
  getStopping: () => boolean;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string, summary?: unknown) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: unknown) => Promise<string>;
  runLeadTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    prompt: string,
    kind: "plan" | "synthesis",
  ) => Promise<string>;
  runWorkerTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    subtask: string,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    successCriteria?: string,
  ) => Promise<void>;
  dispatchHandoffWave: (
    workers: Agent[],
    round: number,
    totalRounds: number,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ) => Promise<void>;
  runDecompositionPeerReview: (
    reviewer: Agent,
    round: number,
    totalRounds: number,
    plan: Plan,
    userDirective?: string,
  ) => Promise<void>;
}

export async function runOwLoopBody(
  host: OwLoopHost,
  cfg: RunConfig,
): Promise<void> {
    const agents = host.manager.list();
    const lead = agents.find((a) => a.index === 1);
    const workers = agents.filter((a) => a.index > 1);
    if (!lead) throw new Error("lead agent (index 1) did not spawn");
    if (workers.length === 0) throw new Error("no workers spawned");

    // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
    const tokenBaseline = snapshotLifetimeTokens();
    const planEmptyGuard = new PlanEmptyDeadLoopGuard({
      roleLabel: "lead",
    });

    for (let r = 1; r <= cfg.rounds; r++) {
      if (!host.checkRoundBudget(cfg, "cycle", r, tokenBaseline)) break;

      // PLAN — lead gets the full transcript (including any prior cycles'
      // syntheses) and produces a fresh plan.
      host.appendSystem(`Cycle ${r}/${cfg.rounds}: lead planning.`);
      let planText = await host.runLeadTurn(
        lead,
        r,
        cfg.rounds,
        buildLeadPlanPrompt(r, cfg.rounds, workers.map((w) => w.index), [...host.transcript], cfg.userDirective),
        "plan",
      );
      if (host.getStopping()) break;

      if (cfg.postSynthesisCritique && planText) {
        const proposals = host.transcript
          .filter(e => e.role === "agent" && e.agentIndex !== 1)
          .slice(-3)
          .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
        planText = await runPostSynthesisCritique({
          synthesis: planText,
          proposals,
          criticAgent: workers[0] ?? lead,
          manager: host.manager,
          appendSystem: (text) => host.appendSystem(text),
          stopping: host.getStopping(),
          runDiscussionAgent: (agent, prompt, opts) => host.runDiscussionAgent(agent, prompt, opts),
          stats: host.stats,
          presetName: "orchestrator-worker",
        });
      }

      const plan = parsePlan(planText, workers.map((w) => w.index));
      // Phase B (Task #101): lead short-circuit. Honor done:true
      // even if the model also emitted assignments alongside —
      // the explicit done flag is a stronger signal than any
      // backup work it might have queued. Skip on cycle 1 (the
      // prompt forbids it; this is defense-in-depth).
      if (plan.done === true && r > 1) {
        host.setEarlyStopDetail(`lead-reports-done after cycle ${r}/${cfg.rounds}`);
        host.appendSystem(
          `Lead reports done — ending OW early at cycle ${r}/${cfg.rounds}.`,
        );
        break;
      }

      // 2026-05-06: when the lead produces no parseable assignments,
      // retry once with a re-prompt that explicitly asks for JSON
      // before counting this cycle as empty. This cuts ~50% of
      // early-stop scenarios where the lead emitted valid thinking
      // but forgot the JSON block.
      let finalPlan = plan;
      if (plan.assignments.length === 0 && planText.length > 20) {
        host.appendSystem(
          `Cycle ${r}: lead output was not valid JSON assignments — retrying with explicit format reminder.`,
        );
        const retryPrompt = buildLeadPlanPrompt(r, cfg.rounds, workers.map((w) => w.index), [...host.transcript], cfg.userDirective)
          + "\n\nIMPORTANT: Your response MUST contain a ```json code block with an \"assignments\" array. For example:\n```json\n{\n  \"assignments\": [\n    {\"agentIndex\": 2, \"subtask\": \"...\", \"successCriteria\": \"...\"},\n    {\"agentIndex\": 3, \"subtask\": \"...\", \"successCriteria\": \"...\"}\n  ]\n}\n```\nDo NOT just explore the repo — you MUST output the JSON block.";
        const retryText = await host.runLeadTurn(lead, r, cfg.rounds, retryPrompt, "plan");
        if (!host.getStopping()) {
          const retryPlan = parsePlan(retryText, workers.map((w) => w.index));
          if (retryPlan.assignments.length > 0) {
            finalPlan = retryPlan;
            host.appendSystem(`Cycle ${r}: retry succeeded — got ${retryPlan.assignments.length} assignments.`);
          }
        }
      }

      const planHit = planEmptyGuard.recordCycle(finalPlan.assignments);
      if (finalPlan.assignments.length === 0) {
        host.appendSystem(
          `Cycle ${r}: lead produced no parseable assignments — skipping execute phase this cycle. Raw lead output preserved in transcript. (consecutive=${planHit.consecutive})`,
        );
        if (planHit.tripped) {
          host.setEarlyStopDetail(planHit.earlyStopDetail);
          host.appendSystem(
            `Lead has produced empty plans for ${planHit.consecutive} consecutive cycles — ending OW early to avoid burning wall-clock on dead loops.`,
          );
          break;
        }
        continue;
      }
      // Counter resets automatically inside recordCycle when assignments.length > 0.

      // T182 (2026-05-04): surface effort distribution + run a peer
      // review of the lead's decomposition. Both fire ONCE per cycle
      // (right after planning, before execute) so workers see any
      // peer-review concern in the system bubble — too late for
      // round 1 (workers already have prompts queued by then) but
      // valid for round 2+ when the lead can refine.
      const efforts = summarizeEffortDistribution(finalPlan.assignments);
      if (efforts) host.appendSystem(`[T182 effort distribution] ${efforts}`);
      // Peer review: pick the lowest-index worker (NOT the lead, NOT
      // the worker assigned to the same subtask we're reviewing) and
      // ask them to flag obvious issues with the plan. Best-effort:
      // any failure is logged + ignored — workers still fire.
      if (workers.length >= 2) {
        await host.runDecompositionPeerReview(
          workers[0]!,
          r,
          cfg.rounds,
          finalPlan,
          cfg.userDirective,
        );
      }

      // EXECUTE — workers fire in parallel. Each sees ONLY its assigned
      // subtask + the seed, not the full transcript or peer reports.
      // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED. v4
      // battle test showed it didn't help OW (same 50% success vs
      // worse) — the parallel cold-start ceiling applied to the warmup
      // batch too. OW relies on serial spawn-warmup from start() only.
      const seedSnapshot = host.transcript.filter((e) => e.role === "system");
      // Task #53: stagger the N parallel worker prompts to avoid the
      // Pattern 3 cold-start queue race confirmed in 2026-04-24 logs.
      await staggerStart(finalPlan.assignments, (a) => {
        const w = workers.find((x) => x.index === a.agentIndex);
        if (!w) return Promise.resolve();
        return host.runWorkerTurn(
          w,
          r,
          cfg.rounds,
          a.subtask,
          seedSnapshot,
          cfg.userDirective,
          a.successCriteria,
        );
      });
      if (host.getStopping()) break;

      // T195 (2026-05-04): cross-worker handoffs. Scan worker reports
      // from THIS cycle for HANDOFF lines + dispatch a mini-wave to
      // the named workers BEFORE synthesis. Best-effort: handoff
      // failure doesn't block synthesis. Only one mini-wave per
      // cycle (handoffs from the mini-wave itself are deferred to
      // the next cycle to bound runaway re-dispatch).
      if (!host.getStopping()) {
        await host.dispatchHandoffWave(workers, r, cfg.rounds, seedSnapshot, cfg.userDirective);
      }
      if (host.getStopping()) break;

      // SYNTHESIZE — lead sees the full transcript again (now including
      // all worker reports from this cycle) and produces a consolidated
      // answer for the cycle.
      host.appendSystem(`Cycle ${r}/${cfg.rounds}: lead synthesizing.`);
      await host.runLeadTurn(
        lead,
        r,
        cfg.rounds,
        buildLeadSynthesisPrompt(r, cfg.rounds, [...host.transcript], cfg.userDirective),
        "synthesis",
      );

      if (cfg.postRoundCritique) {
        await maybeRunPostRoundCritique({
          agents: host.manager.list(),
          round: r,
          totalRounds: cfg.rounds,
          transcript: host.transcript,
          userDirective: cfg.userDirective,
          enabled: cfg.postRoundCritique ?? false,
          runDiscussionAgent: (agent, prompt, opts) => host.runDiscussionAgent(agent, prompt, opts),
          stats: host.stats,
          appendSystem: (text, summary) => host.appendSystem(text, summary),
          presetName: "orchestrator-worker",
          stopping: host.getStopping(),
        });
      }
    }
    if (!host.getStopping()) host.appendSystem("Orchestrator–worker run complete.");
}
