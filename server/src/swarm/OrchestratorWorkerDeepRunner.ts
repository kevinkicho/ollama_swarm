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
import { createOutcomeEmitter, type OutcomeScoredEvent } from "./outcomeTypes.js";
import type { Agent } from "../services/AgentManager.js";
import type {
  SwarmEvent,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { staggerStart } from "./staggerStart.js";
import {
  parsePlan,
  buildWorkerPrompt,
  type Assignment,
  type Plan,
} from "./OrchestratorWorkerRunner.js";
import {
  readDirective,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import { buildOrchestratorWorkerDeepSeedMessage } from "./orchestratorWorkerDeepSeed.js";
import { runOwDeepLoopBody } from "./orchestratorWorkerDeepLoop.js";
import {
  buildTopPlanPrompt,
  buildMidLeadPlanPrompt,
  buildMidLeadSynthesisPrompt,
  buildTopSynthesisPrompt,
  truncate,
  buildOrchestratorReplanPrompt,
  parseMidLeadPushback,
  parseMidLeadTierSkip,
} from "./orchestratorWorkerDeepPromptHelpers.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import { describeSdkError } from "./sdkError.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import { resolveRunSpawnModel } from "./resolveRunSpawnModel.js";
import {
  DEEP_OW_MIN_AGENTS,
  computeDeepTopology,
  type DeepTopology,
} from "./orchestratorWorkerDeepTopology.js";

export {
  TARGET_WORKERS_PER_MID_LEAD,
  DEEP_OW_MIN_AGENTS,
  computeDeepTopology,
  type DeepTopology,
} from "./orchestratorWorkerDeepTopology.js";

export class OrchestratorWorkerDeepRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Orchestrator-Worker-Deep"; }


  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;
  // T199 (2026-05-04): per-cycle pushback tracker. Mid-leads append
  // their pushback (when emitted) here; the runner's outer loop
  // checks at end-of-cycle to decide whether to fire an orchestrator
  // replan (cfg.bidirectionalRefinement). Cleared at start of each
  // cycle.
  private cyclePushbacks: Map<number, string> = new Map();
  private topology?: DeepTopology;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.topology = computeDeepTopology(cfg.agentCount);

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "orchestrator-worker-deep",
      minAgents: DEEP_OW_MIN_AGENTS,
      roleResolver: (a) => (a.index === 1 ? "Lead" : "Worker"),
      extraReadyMessage: ` Agent 1 is the DEEP LEAD; agents 2..${cfg.agentCount} are DEEP WORKERS.`,
    });
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      this.multiWriter = new MultiWriterState({
        writeMode: cfg.writeMode,
        conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["orchestrator-worker-deep"],
        clonePath: destPath,
      });
      this.appendSystem(
        `Multi-writer mode enabled — workers will propose hunks during rounds, reconciled via ${cfg.conflictPolicy ?? "sequential"} policy.`,
      );
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    await this.runTrackedLoop(() => this.loop(cfg));
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const t = this.topology!;
    const { text, summary } = buildOrchestratorWorkerDeepSeedMessage({
      clonePath,
      cfg,
      tree,
      midLeadIndices: t.midLeadIndices,
      workerIndices: t.workerIndices,
    });
    this.appendSystem(text, summary);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await runOwDeepLoopBody(
        {
          manager: this.opts.manager,
          transcript: this.transcript,
          topology: this.topology ?? null,
          getCyclePushbacks: () => this.cyclePushbacks,
          setCyclePushbacks: (m) => { this.cyclePushbacks = m; },
          getStopping: () => this.stopping,
          setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
          appendSystem: (t) => this.appendSystem(t),
          checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
          runAgent: (a, p) => this.runAgent(a, p),
          runMidLeadSubtree: (ml, pool, a, r, tr, snap, d) =>
            this.runMidLeadSubtree(ml, pool, a, r, tr, snap, d),
          getRunId: () => this.active?.runId ?? cfg.runId,
          getBrainService: () => this.opts.getBrainService?.() ?? null,
        },
        cfg,
      );
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
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
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
      // Phase 2 (writeMode: multi): reconcile proposals if multi-writer active
      if (this.multiWriter?.isActive() && this.multiWriter.proposalCount() > 0) {
        const proposals = this.multiWriter.getProposals();
        this.appendSystem(
          `Multi-writer reconcile: ${proposals.length} proposal(s) from ${new Set(proposals.map(p => p.agentId)).size} agent(s).`,
        );

        const currentFiles: Record<string, string | null> = {};
        const allFiles = new Set(proposals.flatMap(p => p.hunks.map(h => h.file)));
        for (const file of allFiles) {
          try {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const absPath = path.join(cfg.localPath, file);
            currentFiles[file] = await fs.readFile(absPath, "utf8");
          } catch {
            currentFiles[file] = null;
          }
        }

        const strategy = cfg.conflictPolicy ?? "sequential";
        const result = await this.multiWriter.reconcile(currentFiles, strategy);

        if (!result.ok) {
          this.appendSystem(
            `Multi-writer reconcile: failed — ${result.conflicts.length} conflict(s) detected.`,
          );
          for (const conflict of result.conflicts.slice(0, 5)) {
            this.appendSystem(
              `  ${conflict.type} on ${conflict.file}: ${conflict.conflictingAgents.map(a => `agent-${a.agentIndex}`).join(", ")}`,
            );
          }
        } else if (result.hunks.length > 0) {
          this.appendSystem(
            `Multi-writer reconcile: ${result.hunks.length} hunk(s) ready to apply (${strategy} strategy).`,
          );

          // Apply reconciled hunks via wrapUpApplyPhase
          const { runWrapUpApplyPhase } = await import("./wrapUpApplyPhase.js");
          const applyResult = await runWrapUpApplyPhase({
            directive: cfg.userDirective ?? "Orchestrator-worker-deep multi-writer synthesis",
            clonePath: cfg.localPath,
            model: cfg.writeModel ?? cfg.model,
            agent: orch,
            repos: this.opts.repos,
            manager: this.opts.manager,
            emit: this.opts.emit,
            appendSystem: (text) => this.appendSystem(text),
            presetName: "orchestrator-worker-deep",
            verifyCommand: cfg.verifyCommand,
            hunksFromSynthesizer: result.hunks,
          });

          if (applyResult.ok) {
            this.appendSystem(
              `Multi-writer apply: ${applyResult.hunksApplied}/${applyResult.hunksAttempted} hunk(s) committed (${applyResult.commitSha?.slice(0, 7)}).`,
            );
          } else {
            this.appendSystem(
              `Multi-writer apply: failed — ${applyResult.reason}`,
            );
          }
        } else {
          this.appendSystem(`Multi-writer reconcile: 0 hunks to apply.`);
        }
      }

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
    // T199 (2026-05-04): bi-directional refinement (production).
    // Track pushbacks per cycle so the outer loop can fire an
    // orchestrator replan when cfg.bidirectionalRefinement is on.
    const pushback = parseMidLeadPushback(midPlanText);
    if (pushback) {
      this.appendSystem(
        `[T199 mid-lead pushback] mid-lead ${midLead.index} flagged the coarse subtask: ${pushback}`,
      );
      this.cyclePushbacks.set(midLead.index, pushback);
    }
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

  // T196 (2026-05-04): pick the right per-tier model for this agent.
  // Orchestrator (index 1) → cfg.orchestratorModel; mid-leads (index
  // in topology.midLeadIndices) → cfg.midLeadModel; workers → existing
  // cfg.workerModel. Each falls back to undefined when not set so
  // promptWithRetry uses the agent's spawn-time model.
  private pickTierModel(agentIndex: number): string | undefined {
    if (!this.active) return undefined;
    return resolveRunSpawnModel(this.active, agentIndex);
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
    // T196 (2026-05-04): per-tier model routing. Pick model based on
    // agent's tier in the topology — orchestrator (idx=1) /
    // mid-leads / workers. Each tier falls back to cfg.model when
    // its specific override isn't set.
    const tierModel = this.pickTierModel(agent.index);
    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = await promptWithFailoverAuto(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        agentName: this.multiWriter?.isActive()
          ? (await import("./discussionToolProfile.js")).discussionBuilderProfile(this.active)
          : "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: describeSdkError,
        // T196: per-tier model override.
        ...(tierModel ? { modelOverride: tierModel } : {}),
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
        },
      });
      const diagCtx = {
        runner: "orchestrator-worker-deep",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
        manager: this.opts.manager,
        signal: controller.signal,
        runId: this.active?.runId,
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
      const stripped = finalizeAgentOutput(text, { role: "general" });
      // Phase 2 (writeMode: multi): collect hunk proposals if multi-writer active
      if (this.multiWriter?.isActive()) {
        const proposalResult = await this.multiWriter.addProposal(agent, stripped.finalText);
        if (!proposalResult.skipped && proposalResult.hunks.length > 0) {
          this.appendSystem(
            `[${agent.id}] proposed ${proposalResult.hunks.length} hunk(s)` +
              (proposalResult.fromWorkingTree ? " (workingTree snapshot)" : "") +
              ` — collected for reconciliation.`,
          );
        }
      }
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

}
