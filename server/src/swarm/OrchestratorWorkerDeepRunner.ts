// Task #131: 3-tier orchestrator-worker.
//
// The single-tier OW (OrchestratorWorkerRunner) puts ONE lead in front of
// every worker. As N grows past ~8 workers, the lead's plan-prompt context
// inflates (transcript + worker reports + the planning prose) and the lead
// starts thrashing — picking dead-end subtasks, repeating prior cycles'
// assignments, or just emitting empty plans. Industry consensus is that
// past ~8 reports, you need a tree.
//
// Topology (fixed at start, not dynamic):
//   - Agent 1 = ORCHESTRATOR (top): sees the full transcript, dispatches
//     ONE coarse subtask per mid-lead.
//   - Agents 2..K+1 = MID-LEADS: each gets its orchestrator subtask + its
//     own worker pool, fans out to its workers in parallel, synthesizes
//     their reports back upward.
//   - Agents K+2..N = WORKERS: see only their own subtask + the seed —
//     same isolation guarantee as flat OW.
//
// K is chosen at start to target ~5 workers per mid-lead:
//   K = max(1, ceil((agentCount - 1) / 6))
// Workers are split round-robin across mid-leads at start so each mid-lead
// has ~floor(W/K) or ~ceil(W/K) workers.
//
// Per cycle the runner does FIVE phases (vs. flat OW's three):
//   1. TOP-PLAN     orchestrator → K coarse subtasks
//   2. MID-PLAN     each mid-lead (parallel) → fine subtasks for its workers
//   3. EXECUTE      workers (parallel within each mid-lead's pool) → reports
//   4. MID-SYNTH    each mid-lead (parallel) → consolidated report up to orch
//   5. TOP-SYNTH    orchestrator → cycle answer drawing on mid-lead summaries
//
// Worker-to-mid-lead binding is FIXED at start. We could rebalance per
// cycle but that adds churn for marginal benefit; the static binding lets
// each mid-lead build session continuity with its workers across cycles.
//
// Discussion-only, no file edits — same as flat OW. The point is coverage,
// not landing changes; verifier (#128) is the path that protects file-edit
// correctness, and verifier today is blackboard-only.

import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import {
  buildSeedSummary,
} from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { staggerStart } from "./staggerStart.js";
import {
  parsePlan,
  buildWorkerPrompt,
  type Assignment,
} from "./OrchestratorWorkerRunner.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";

// Target workers per mid-lead. Picked empirically from #131's industry-
// consensus note ("past ~8 workers, you need a tree"). At 6, the
// orchestrator's mid-lead-plan prompt stays compact and each mid-lead's
// worker-plan prompt also stays compact — no tier in the tree blows
// past ~8 reports.
export const TARGET_WORKERS_PER_MID_LEAD = 6;

// Hard floor on the agent count for deep mode. 1 orchestrator + 1
// mid-lead + 2 workers = the smallest layout where the layer adds
// coverage over flat OW. The route schema enforces a higher floor in
// practice, but we re-validate here too — defensive defaults are
// cheaper than diagnosing a 4-AM crash.
export const DEEP_OW_MIN_AGENTS = 4;

export interface DeepTopology {
  orchestratorIndex: number; // always 1
  midLeadIndices: number[]; // K mid-leads
  workerIndices: number[]; // N - K - 1 workers
  // workerByMidLead[i] = worker indices managed by midLeadIndices[i].
  // Lengths sum to workerIndices.length. Always non-empty per mid-lead
  // (we ensure each mid-lead has at least 1 worker by construction).
  workerByMidLead: number[][];
}

// Pure topology computation. Exported for testability so the
// "K mid-leads, ~5 workers each" rule can be pinned without spinning
// up a runner.
export function computeDeepTopology(agentCount: number): DeepTopology {
  if (agentCount < DEEP_OW_MIN_AGENTS) {
    throw new Error(
      `orchestrator-worker-deep needs at least ${DEEP_OW_MIN_AGENTS} agents (1 orchestrator + 1 mid-lead + 2 workers); got ${agentCount}`,
    );
  }
  // Reserve agent 1 for orchestrator. Of the remaining N-1, decide how
  // many become mid-leads. We want each mid-lead to manage at least 2
  // workers, so K is bounded by floor((N-1)/3): K mid-leads + 2K workers
  // = 3K agents under the orchestrator. Within that bound, target the
  // ~6-per-mid-lead ratio.
  const remaining = agentCount - 1;
  const targetK = Math.max(1, Math.ceil(remaining / TARGET_WORKERS_PER_MID_LEAD));
  const maxK = Math.max(1, Math.floor(remaining / 3));
  const k = Math.min(targetK, maxK);
  const midLeadIndices = Array.from({ length: k }, (_, i) => i + 2);
  const workerIndices = Array.from(
    { length: remaining - k },
    (_, i) => i + 2 + k,
  );
  // Round-robin assign workers to mid-leads so any size disparity is
  // ≤1 worker. Stable and deterministic.
  const workerByMidLead: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < workerIndices.length; i++) {
    workerByMidLead[i % k]!.push(workerIndices[i]!);
  }
  return {
    orchestratorIndex: 1,
    midLeadIndices,
    workerIndices,
    workerByMidLead,
  };
}

export class OrchestratorWorkerDeepRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase B: orchestrator can short-circuit by emitting done:true.
  private earlyStopDetail?: string;
  private topology?: DeepTopology;

  constructor(private readonly opts: RunnerOpts) {}

  status(): SwarmStatus {
    return {
      phase: this.phase,
      round: this.round,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: this.opts.manager.toStates(),
      transcript: [...this.transcript],
      streaming: this.opts.manager.getPartialStreams(),
    };
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    const intent = opts?.intent ?? "steer";
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
      intent,
      ...(opts?.targetAgent ? { targetAgent: opts.targetAgent } : {}),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
    this.appendSystem(formatChatReceipt(intent, opts?.targetAgent));
  }

  isRunning(): boolean {
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.earlyStopDetail = undefined;
    this.topology = computeDeepTopology(cfg.agentCount);

    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    const { destPath } = cloneResult;
    this.opts.emit({
      type: "clone_state",
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    });
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    // E3 Phase 5: opencode.json no longer needed.
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgentNoOpencode({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length === 0) throw new Error("No agents started successfully");
    if (ready.length < DEEP_OW_MIN_AGENTS) {
      throw new Error(
        `orchestrator-worker-deep needs at least ${DEEP_OW_MIN_AGENTS} agents up; only ${ready.length}/${cfg.agentCount} started`,
      );
    }
    const t = this.topology;
    const layoutDesc =
      `Agent ${t.orchestratorIndex} = ORCHESTRATOR; ` +
      `agents ${t.midLeadIndices.join(",")} = MID-LEADS (${t.midLeadIndices.length}); ` +
      `agents ${t.workerIndices.join(",")} = WORKERS (${t.workerIndices.length}, split as ${t.workerByMidLead.map((g) => g.length).join("/")}).`;
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. ${layoutDesc}`,
    );
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const t = this.topology!;
    // 2026-05-02 (OW-Deep directive lever): orchestrator decomposes
    // directive into coarse mid-lead questions; mid-leads decompose
    // those into worker subtasks; workers execute toward the directive.
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "The orchestrator decomposes the directive into coarse questions for each mid-lead. Each mid-lead decomposes its coarse question into worker subtasks. Workers execute toward the directive. Mid-leads + orchestrator synthesize a directive answer.",
        ],
      }),
      "Pattern: 3-tier orchestrator-worker (deep).",
      `  Tier 1 — orchestrator (agent 1)`,
      `  Tier 2 — ${t.midLeadIndices.length} mid-leads (agents ${t.midLeadIndices.join(", ")})`,
      `  Tier 3 — ${t.workerIndices.length} workers, partitioned across mid-leads`,
      "",
      "Per cycle: orchestrator dispatches one coarse subtask per mid-lead; each mid-lead breaks its subtask into worker subtasks; workers execute in parallel; mid-leads synthesize upward; orchestrator synthesizes the cycle.",
    ];
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const t = this.topology!;
      const allAgents = this.opts.manager.list();
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
        if (this.stopping) break;
        const guard = checkBudgetGuards({
          tokenBaseline,
          tokenBudget: cfg.tokenBudget,
          round: r,
          totalRounds: cfg.rounds,
          unit: "cycle",
        });
        if (guard.halt) {
          this.earlyStopDetail = guard.earlyStopDetail;
          this.appendSystem(guard.message ?? "");
          break;
        }
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        // Phase 1 — TOP-PLAN
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: orchestrator planning at top level.`);
        const topPlanText = await this.runAgent(
          orchestrator,
          buildTopPlanPrompt(r, cfg.rounds, liveMidLeads.map((m) => m.index), [...this.transcript], cfg.userDirective),
        );
        if (this.stopping) break;
        const topPlan = parsePlan(topPlanText, liveMidLeads.map((m) => m.index));
        if (topPlan.done === true && r > 1) {
          this.earlyStopDetail = `orchestrator-reports-done after cycle ${r}/${cfg.rounds}`;
          this.appendSystem(
            `Orchestrator reports done — ending OW-deep early at cycle ${r}/${cfg.rounds}.`,
          );
          break;
        }
        // 2026-05-03 (Phase B): plan-empty guard extracted to shared class.
        const planHit = planEmptyGuard.recordCycle(topPlan.assignments);
        if (topPlan.assignments.length === 0) {
          this.appendSystem(
            `Cycle ${r}: orchestrator produced no parseable mid-lead assignments — skipping execute phase this cycle. (consecutive=${planHit.consecutive})`,
          );
          if (planHit.tripped) {
            this.earlyStopDetail = planHit.earlyStopDetail;
            this.appendSystem(
              `Orchestrator has produced empty plans for ${planHit.consecutive} consecutive cycles — ending OW-deep early to avoid burning wall-clock on dead loops.`,
            );
            break;
          }
          continue;
        }
        // Counter resets automatically inside recordCycle when assignments.length > 0.

        // Phase 2 + 3 + 4 — Each mid-lead, in parallel: plan → workers → synth.
        // The seed snapshot all sub-prompts share is the system messages
        // captured BEFORE this cycle's per-mid-lead activity.
        const seedSnapshot = this.transcript.filter((e) => e.role === "system");
        await staggerStart(topPlan.assignments, async (a) => {
          const midLeadIdx = a.agentIndex;
          const midLeadPos = liveMidLeads.findIndex((m) => m.index === midLeadIdx);
          if (midLeadPos < 0) return;
          const midLead = liveMidLeads[midLeadPos]!;
          const pool = liveWorkerPools[midLeadPos]!;
          await this.runMidLeadSubtree(midLead, pool, a, r, cfg.rounds, seedSnapshot, cfg.userDirective);
        });
        if (this.stopping) break;

        // Phase 5 — TOP-SYNTH
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: orchestrator synthesizing across mid-lead reports.`);
        await this.runAgent(
          orchestrator,
          buildTopSynthesisPrompt(r, cfg.rounds, [...this.transcript], cfg.userDirective),
        );
      }
      if (!this.stopping) this.appendSystem("Orchestrator-worker-deep run complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-02 (deliverables initiative): structured markdown.
      if (!this.stopping && cfg.runId) await this.writeOwDeepDeliverable(cfg);
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // Reflection: orchestrator (index 1); skipped when topology is null.
      const topo = this.topology;
      await runDiscussionCloseOut({
        cfg,
        crashMessage,
        stopping: this.stopping,
        earlyStopDetail: this.earlyStopDetail,
        round: this.round,
        currentPhase: this.phase,
        manager: this.opts.manager,
        appendSystem: (text) => this.appendSystem(text),
        setPhase: (p) => this.setPhase(p),
        writeSummary: () => this.writeSummary(cfg, crashMessage),
        hooks: {
          pickReflectionAgent: (m) =>
            topo ? (m.list().find((a) => a.index === 1) ?? null) : null,
          buildReflectionContext: (s) =>
            `Orchestrator-worker-deep · 1 orchestrator + ${topo?.midLeadIndices.length ?? 0} mid-leads + ${topo?.workerIndices.length ?? 0} workers · ran ${s.round}/${cfg.rounds} cycles${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
      });
    }
  }

  // 2026-05-02 (deliverables initiative): orchestrator-worker-deep
  // structured artifact. Sections: top plan / mid-lead syntheses /
  // per-worker findings. Last agent entry from the orchestrator (index 1)
  // is treated as the final synthesis.
  private async writeOwDeepDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective(cfg);
    const orchestratorEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex === 1,
    );
    const finalSynthesis = orchestratorEntries[orchestratorEntries.length - 1]?.text?.trim() || "_(no orchestrator synthesis)_";
    const midLeadIdxs = this.topology?.midLeadIndices ?? [];
    const workerIdxs = this.topology?.workerIndices ?? [];
    const midLeadEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex !== undefined && midLeadIdxs.includes(e.agentIndex),
    );
    const workerEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex !== undefined && workerIdxs.includes(e.agentIndex),
    );
    const sections: Array<{ title: string; body: string }> = [];
    const directiveSection = maybeDirectiveSection(dirCtx);
    if (directiveSection) sections.push(directiveSection);
    sections.push(
      {
        title: pickAnswerSectionTitle(dirCtx, {
          withDirective: "Answer to directive",
          withoutDirective: "Top synthesis (orchestrator)",
        }),
        body: finalSynthesis,
      },
      {
        title: `Mid-lead syntheses (${midLeadEntries.length} entries)`,
        body: midLeadEntries.length > 0
          ? midLeadEntries.map((e) => `### Mid-lead ${e.agentIndex}\n\n${e.text.trim()}`).join("\n\n")
          : "_(no mid-lead syntheses)_",
      },
      {
        title: `Per-worker findings (${workerEntries.length} entries)`,
        body: workerEntries.length > 0
          ? workerEntries.map((e) => `### Worker ${e.agentIndex}\n\n${e.text.trim()}`).join("\n\n")
          : "_(no worker findings)_",
      },
    );
    // 2026-05-02 (quality levers #1+#3): augment with critic + next-actions.
    const orch = this.opts.manager.list().find((a) => a.index === 1) ?? null;
    const augmented = await runQualityPasses({
      baseSections: sections,
      rubric: null,
      criticAgent: orch,
      manager: this.opts.manager,
    });
    const subtitleBase = `1 orchestrator + ${midLeadIdxs.length} mid-lead${midLeadIdxs.length === 1 ? "" : "s"} + ${workerIdxs.length} worker${workerIdxs.length === 1 ? "" : "s"}${this.earlyStopDetail ? " · early-stop" : ""}`;
    writeDeliverableAndEmit(
      {
        preset: "orchestrator-worker-deep",
        runId: cfg.runId,
        clonePath: cfg.localPath,
        title: pickDeliverableTitle(dirCtx, {
          withDirective: "Orchestrator-worker-deep: directive answer",
          withoutDirective: "Orchestrator-worker-deep report",
        }),
        subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
        sections: augmented,
      },
      { transcript: this.transcript, emit: this.opts.emit },
    );

    // T2.2 (2026-05-04): opt-in wrap-up apply phase. Top orchestrator
    // (agent-1) doubles as implementer.
    if (orch) {
      await maybeRunWrapUpApply({
        cfg,
        presetName: "orchestrator-worker-deep",
        agent: orch,
        manager: this.opts.manager,
        repos: this.opts.repos,
        emit: this.opts.emit,
        appendSystem: (text) => this.appendSystem(text),
      });
    }
  }

  // Phases 2, 3, 4 for one mid-lead's subtree. Runs MID-PLAN to break
  // the orchestrator's coarse subtask into per-worker subtasks, fans out
  // workers in parallel, then MID-SYNTH consolidates back into a single
  // mid-lead report. Errors are logged but don't break the parent loop —
  // sister mid-leads keep running.
  private async runMidLeadSubtree(
    midLead: Agent,
    workers: Agent[],
    coarseAssignment: Assignment,
    round: number,
    totalRounds: number,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    if (this.stopping) return;
    this.appendSystem(
      `[mid-lead ${midLead.index}] cycle ${round}: planning ${workers.length} worker subtask(s) for "${truncate(coarseAssignment.subtask)}"`,
    );
    const midPlanText = await this.runAgent(
      midLead,
      buildMidLeadPlanPrompt(
        midLead.index,
        round,
        totalRounds,
        coarseAssignment.subtask,
        workers.map((w) => w.index),
        seedSnapshot,
        userDirective,
      ),
    );
    if (this.stopping) return;
    // T192 (2026-05-04): tier-skip honor. T183 added the prompt schema
    // (`tierSkip: true` + `selfReport`); this wires the runner to
    // honor it. When mid-lead opts to handle the coarse subtask
    // itself, post the selfReport as the upward synthesis and skip
    // workers entirely. Cuts a round-trip when the orchestrator
    // over-decomposed a trivial subtask.
    const tierSkip = parseMidLeadTierSkip(midPlanText);
    if (tierSkip.tierSkip && tierSkip.selfReport) {
      this.appendSystem(
        `[mid-lead ${midLead.index}] tier-skip: handling coarse subtask "${truncate(coarseAssignment.subtask)}" directly without dispatching workers (saves ${workers.length} worker turn${workers.length === 1 ? "" : "s"}).`,
      );
      // Post the selfReport as the mid-lead's synthesis upward.
      this.appendSystem(
        `[mid-lead ${midLead.index}] tier-skip self-report:\n\n${tierSkip.selfReport.trim()}`,
      );
      return;
    }
    const midPlan = parsePlan(midPlanText, workers.map((w) => w.index));
    if (midPlan.assignments.length === 0) {
      this.appendSystem(
        `[mid-lead ${midLead.index}] no parseable worker assignments — skipping worker execution this cycle.`,
      );
      return;
    }
    await staggerStart(midPlan.assignments, (a) => {
      const w = workers.find((x) => x.index === a.agentIndex);
      if (!w) return Promise.resolve();
      return this.runWorkerForMidLead(w, midLead.index, round, totalRounds, a.subtask, seedSnapshot, userDirective);
    });
    if (this.stopping) return;
    this.appendSystem(`[mid-lead ${midLead.index}] cycle ${round}: synthesizing worker reports upward.`);
    await this.runAgent(
      midLead,
      buildMidLeadSynthesisPrompt(midLead.index, round, totalRounds, coarseAssignment.subtask, [...this.transcript], userDirective),
    );
  }

  private async runWorkerForMidLead(
    worker: Agent,
    midLeadIndex: number,
    round: number,
    totalRounds: number,
    subtask: string,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    // Reuse flat OW's worker prompt — the worker's experience is the same
    // whether its assigner is a flat lead or a mid-lead. Tag the announcement
    // so the transcript shows the chain of command.
    // 2026-05-02 (chat lever #3): per-worker @mention filter.
    const visibleSeed = seedSnapshot.filter((e) => userEntryVisibleTo(e, worker.id));
    const prompt = buildWorkerPrompt(worker.index, round, totalRounds, subtask, visibleSeed, userDirective);
    this.appendSystem(`[mid-lead ${midLeadIndex} → worker ${worker.index}] dispatching: ${truncate(subtask)}`);
    await this.runAgent(worker, prompt);
  }

  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
    // 2026-05-03 (Phase C): writeSummary body extracted to shared helper.
    await discussionWriteSummary({
      cfg,
      crashMessage,
      stopping: this.stopping,
      startedAt: this.startedAt,
      earlyStopDetail: this.earlyStopDetail,
      agentCount: cfg.agentCount,
      agents: this.stats.buildPerAgentStats(),
      transcript: this.transcript,
      topology: cfg.topology,
      repos: this.opts.repos,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
    });
  }

  // The runAgent shape matches OrchestratorWorkerRunner's — same retry,
  // same junk handling, same per-agent stats hooks. Inlined rather than
  // pulled into a shared helper because every preset has subtle drift in
  // what it tags / extracts from response text.
  private async runAgent(agent: Agent, prompt: string): Promise<string> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    this.stats.countTurn(agent.id);
    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      const res = await promptWithRetry(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: describeSdkError,
        onTiming: ({ attempt, elapsedMs, success }) => {
          this.stats.onTiming(agent.id, success, elapsedMs);
          this.opts.logDiag?.({
            type: "_prompt_timing",
            preset: this.active?.preset,
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
          });
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          this.opts.emit({
            type: "agent_latency_sample",
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
            ts: Date.now(),
          });
        },
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
          this.stats.onRetry(agent.id);
          this.appendSystem(
            `[${agent.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
          );
          this.opts.manager.markStatus(agent.id, "retrying", {
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
          this.emitAgentState({
            id: agent.id,
            index: agent.index,
            port: agent.port,
            sessionId: agent.sessionId,
            status: "retrying",
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
        },
      });
      const diagCtx = {
        runner: "orchestrator-worker-deep",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(agent, prompt, "swarm-read", diagCtx);
        if (retryText !== null) text = retryText;
      }
      trackPostRetryJunk(text, {
        agentId: agent.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: entry.ts,
      });
      return text;
    } catch (err) {
      const msg = watchdog.getAbortReason() ?? describeSdkError(err);
      this.appendSystem(`[${agent.id}] error: ${msg}`);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "failed",
        error: msg,
      });
      return "";
    } finally {
      watchdog.cancel();
    }
  }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
  }

  private emitAgentState(s: AgentState): void {
    this.opts.manager.recordAgentState(s);
  }
}

// ---------------------------------------------------------------------
// Prompt builders.
// ---------------------------------------------------------------------

export function buildTopPlanPrompt(
  round: number,
  totalRounds: number,
  midLeadIndices: readonly number[],
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  const midList = midLeadIndices.map((i) => `Agent ${i}`).join(", ");
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this 3-tier swarm is answering)",
    framingLines: [
      "Decompose the directive into ONE coarse sub-question per mid-lead. Each coarse subtask should target a distinct angle of the directive (e.g. for 'refactor X to Y': call-site mapping, API design, test coverage, migration path). Mid-leads will further decompose into per-worker subtasks.",
    ],
  });
  const directive = dirCtx.directive;
  return [
    "You are the ORCHESTRATOR (top tier) of a 3-tier swarm.",
    `This is the planning phase of cycle ${round}/${totalRounds}.`,
    `Below you are ${midLeadIndices.length} MID-LEADS: ${midList}. Each manages its own pool of workers; you do NOT see workers directly.`,
    "Assign ONE coarse subtask per mid-lead — they will break it down further for their workers.",
    "",
    ...directiveBlock,
    "REQUIRED VERIFICATION (Task #83 carry-over): use `list` / `glob` / `read` first to confirm the directories you intend to dispatch ACTUALLY EXIST. Don't dispatch a mid-lead to /src/utils/ if there is no utils dir.",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"done": false, "assignments": [{"agentIndex": 2, "subtask": "…"}, …]}',
    "",
    "Rules:",
    "- Each subtask is COARSE: one paragraph or so describing a major area of investigation. The mid-lead will further decompose it into per-worker subtasks.",
    "- Do NOT specify worker-level detail — that's the mid-lead's job.",
    "- One subtask per mid-lead per cycle. Avoid overlap between mid-leads.",
    `- On cycle ${round}, ${round === 1
      ? directive.length > 0
        ? "decompose the directive into orthogonal sub-questions — one coarse subtask per mid-lead. Verify paths exist before dispatching."
        : "start with broad coverage of the repo (e.g. one mid-lead per top-level directory or per system area)."
      : "use prior cycle syntheses to narrow into gaps the prior cycle surfaced."
    }`,
    "",
    "Set `done: true` (assignments: []) ONLY when prior cycles have exhausted meaningful coverage. On cycle 1, `done` MUST be false.",
    "",
    "=== TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — this is the first planning step)",
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

export function buildMidLeadPlanPrompt(
  midLeadIndex: number,
  round: number,
  totalRounds: number,
  coarseSubtask: string,
  workerIndices: readonly number[],
  seedSnapshot: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const seedText = seedSnapshot.map((e) => `[SYSTEM] ${e.text}`).join("\n\n");
  const workerList = workerIndices.map((i) => `Agent ${i}`).join(", ");
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the whole swarm is answering)",
    framingLines: [
      "Your coarse subtask is the orchestrator's decomposition of one piece of the directive. Decompose IT further so each worker subtask produces evidence the orchestrator needs to answer the directive.",
    ],
  });
  return [
    `You are MID-LEAD Agent ${midLeadIndex} in a 3-tier orchestrator-worker swarm.`,
    `This is cycle ${round}/${totalRounds}. The orchestrator just dispatched you a coarse subtask, and you have ${workerIndices.length} workers under you: ${workerList}.`,
    "",
    ...directiveBlock,
    "=== YOUR COARSE SUBTASK FROM ORCHESTRATOR ===",
    coarseSubtask,
    "=== END COARSE SUBTASK ===",
    "",
    `Break the coarse subtask into ${workerIndices.length} fine-grained worker subtasks — one per worker — that COLLECTIVELY cover what the orchestrator asked.`,
    "Workers see only their fine subtask + the seed below; not your plan, not the orchestrator's plan, not peer worker reports. Subtasks must be self-contained.",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"assignments": [{"agentIndex": <worker-index>, "subtask": "…"}, …], "tierSkip": false}',
    "",
    "Rules:",
    "- One assignment per worker. Cover non-overlapping aspects.",
    "- Use file paths from the seed when relevant. Be concrete.",
    "- Subtask text under ~200 chars each. Workers should be able to act on them without further clarification.",
    "",
    // T183 (2026-05-04): tier-skipping. Mid-lead can opt to handle a
    // genuinely-trivial coarse subtask itself without dispatching to
    // workers. Cuts overhead when the orchestrator over-decomposed.
    // Emit `\"tierSkip\": true` AND `\"selfReport\": \"<one paragraph>\"`
    // alongside (or instead of) assignments. Today the runner logs
    // the request + still dispatches workers; future work will honor
    // it by skipping execute for this mid-lead's branch.
    "**Tier-skipping (optional)** — set `\"tierSkip\": true` AND include `\"selfReport\": \"<one-paragraph answer to the coarse subtask>\"` if the coarse subtask is genuinely trivial enough that you can do it yourself in one paragraph (e.g. \"name the file that defines X\" or \"check whether dir Y exists\"). Cuts the round-trip through workers when over-decomposed. Otherwise leave it false / omit and dispatch normally.",
    "",
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
  ].join("\n");
}

export function buildMidLeadSynthesisPrompt(
  midLeadIndex: number,
  round: number,
  totalRounds: number,
  coarseSubtask: string,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the whole swarm is answering)",
  });
  return [
    `You are MID-LEAD Agent ${midLeadIndex}. Your workers just reported on the subtasks you assigned them this cycle.`,
    `Cycle ${round}/${totalRounds}.`,
    "",
    ...directiveBlock,
    "=== ORCHESTRATOR'S ORIGINAL COARSE SUBTASK TO YOU ===",
    coarseSubtask,
    "=== END ===",
    "",
    "Read every worker report in the transcript below. Produce a TIGHT synthesis (under ~250 words) directed UPWARD to the orchestrator. The synthesis should:",
    // T183 (2026-05-04): mid-lead clustering. Before summarizing,
    // explicitly group worker findings into themes — same finding
    // reported by 2+ workers is a stronger signal than a single
    // worker's claim. Reduces orchestrator's cognitive load and
    // prevents N nearly-identical findings from drowning out the
    // single distinct one.
    "- **Cluster findings into themes FIRST.** Group similar findings (e.g. \"3 workers flagged auth/ as untested\" rather than 3 separate auth-untested bullets). Distinct findings (only 1 worker raised) get their own bullet but tagged as such. Cross-worker convergence is the strongest signal — surface it.",
    "- Summarize what your workers found, attributed to specific workers (e.g. \"Agent 5 noted…\").",
    dirCtx.hasDirective
      ? "- Answer the coarse subtask the orchestrator gave you, IN SERVICE of the directive. Be honest about gaps your workers couldn't resolve."
      : "- Answer the coarse subtask the orchestrator gave you. Be honest about gaps your workers couldn't resolve.",
    "- Stay terse — the orchestrator will read N of these (one per mid-lead) and needs density.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis upward to the orchestrator.",
  ].join("\n");
}

export function buildTopSynthesisPrompt(
  round: number,
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const isFinal = round === totalRounds;
  if (dirCtx.hasDirective) {
    const closing = isFinal
      ? "4. **Final recommendation** — your one concrete next step toward the directive. Cite mid-lead findings."
      : "4. **Coverage gap toward the directive** — name one piece next cycle's plan should target.";
    return [
      "You are the ORCHESTRATOR. Each mid-lead just reported back its synthesis of its workers' findings.",
      `Cycle ${round}/${totalRounds}.`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the question this 3-tier swarm is answering)",
      }),
      "Read every mid-lead synthesis in the transcript. Produce the cycle's final synthesis (under ~500 words) structured as:",
      "1. **Answer to directive** — direct response built from mid-lead findings. Cite mid-leads + the workers they cited + file paths.",
      "2. **Supporting evidence** — list the specific mid-lead findings that ground the answer.",
      "3. **Tensions / open questions** — places where mid-leads disagreed or couldn't answer. Be honest about confidence.",
      closing,
      "",
      "Cite mid-leads by index (e.g. \"Mid-lead 2 surfaced…\"). Don't re-invent evidence not in a mid-lead synthesis — workers already filtered the raw observations through their mid-lead.",
      "",
      "=== TRANSCRIPT ===",
      transcriptText,
      "=== END TRANSCRIPT ===",
      "",
      "Now write your top-level synthesis.",
    ].join("\n");
  }
  return [
    "You are the ORCHESTRATOR. Each mid-lead just reported back its synthesis of its workers' findings.",
    `Cycle ${round}/${totalRounds}.`,
    "",
    "Read every mid-lead synthesis in the transcript and produce the cycle's final synthesis (under ~400 words) that:",
    "1. Names what the project is and who it's for.",
    "2. Pulls together what's working / what's missing across all mid-lead reports.",
    "3. Proposes one concrete next action the swarm should take, citing which mid-lead's findings drove it.",
    isFinal
      ? "4. Closes with a final recommendation now that this is the last cycle."
      : "4. Flags ONE gap or inconsistency across mid-lead reports that a future cycle should investigate.",
    "",
    "Cite mid-leads by index (e.g. \"Mid-lead 2 surfaced…\"). Don't re-invent evidence not in a mid-lead synthesis — workers already filtered the raw observations through their mid-lead.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your top-level synthesis.",
  ].join("\n");
}


function truncate(s: string, max: number = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// T192 (2026-05-04): parse the mid-lead's tier-skip request from raw
// plan output. Returns `{tierSkip, selfReport?}`. Tolerant of fenced
// JSON + bare braces; same parser pattern as parsePlan in flat OW.
// Both fields optional in the JSON; an absent / falsy `tierSkip`
// returns `{tierSkip: false}` so the runner-side check is simple.
export function parseMidLeadTierSkip(raw: string): {
  tierSkip: boolean;
  selfReport?: string;
} {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return { tierSkip: false };
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return { tierSkip: false };
    }
  }
  if (!parsed || typeof parsed !== "object") return { tierSkip: false };
  const o = parsed as Record<string, unknown>;
  const tierSkip = o.tierSkip === true;
  if (!tierSkip) return { tierSkip: false };
  const selfReport =
    typeof o.selfReport === "string" && o.selfReport.trim().length > 0
      ? o.selfReport.trim()
      : undefined;
  return { tierSkip: true, ...(selfReport ? { selfReport } : {}) };
}
