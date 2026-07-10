import { randomUUID } from "node:crypto";
import { createOutcomeEmitter, type OutcomeScoredEvent } from "./outcomeTypes.js";
import type { Agent } from "../services/AgentManager.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  AgentState,
  SwarmEvent,
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";

import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { selectModelForRole } from "./dynamicModelRoute.js";
import { defaultRoleForIndex } from "@ollama-swarm/shared/topology";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { buildOrchestratorWorkerSeedMessage } from "./orchestratorWorkerSeed.js";
import { runOwLoopBody } from "./orchestratorWorkerLoop.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { staggerStart } from "./staggerStart.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import { describeSdkError } from "./sdkError.js";
import {
  readDirective,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import {
  type Assignment,
  type Plan,
  type HandoffRequest,
  parsePlan,
  buildLeadPlanPrompt,
  buildWorkerPrompt,
  buildLeadSynthesisPrompt,
  parseAssignmentsSummary,
  parseHandoffLines,
  summarizeEffortDistribution,
  buildDecompositionReviewPrompt,
} from "./orchestratorWorkerPromptHelpers.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";

// Orchestrator–worker hierarchy.
// Agent 1 is the LEAD: it reads the repo, produces a plan assigning one
// subtask to each worker, then (after workers return) synthesizes a final
// answer from their reports. Agents 2..N are WORKERS: they receive only
// their assigned subtask plus the seed — NOT the shared transcript, NOT
// peer workers' reports. Each worker's output is a structured report that
// feeds the lead's synthesis.
//
// `rounds` = number of plan→execute→synthesize cycles. Between cycles, the
// lead sees its own prior synthesis and may refine the plan. Workers are
// always fresh-subtask; they don't accumulate context across cycles.
//
// Discussion-only, no file edits. The value over council is directed
// division of labor: the lead decides who studies what, so coverage is
// controlled rather than emergent.
export class OrchestratorWorkerRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Orchestrator-Worker"; }

  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.

  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "orchestrator-worker",
      minAgents: 2,
      roleResolver: (a) => (a.index === 1 ? "Lead" : "Worker"),
      extraReadyMessage: ` Agent 1 is the LEAD; agents 2..${cfg.agentCount} are WORKERS.`,
    });
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      this.multiWriter = new MultiWriterState({
        writeMode: cfg.writeMode,
        conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["orchestrator-worker"],
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
    const { text, summary } = buildOrchestratorWorkerSeedMessage({ clonePath, cfg, tree });
    this.appendSystem(text, summary);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await runOwLoopBody(
        {
          manager: this.opts.manager,
          transcript: this.transcript,
          stats: this.stats,
          getStopping: () => this.stopping,
          setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
          appendSystem: (t, s) => this.appendSystem(t, s as any),
          checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
          runDiscussionAgent: (a, p, o) => this.runDiscussionAgent(a, p, o as any),
          runLeadTurn: (a, r, tr, p, k) => this.runLeadTurn(a, r, tr, p, k),
          runWorkerTurn: (a, r, tr, s, snap, d, sc) =>
            this.runWorkerTurn(a, r, tr, s, snap, d, sc),
          dispatchHandoffWave: (w, r, tr, snap, d) =>
            this.dispatchHandoffWave(w, r, tr, snap, d),
          runDecompositionPeerReview: (rev, r, tr, plan, d) =>
            this.runDecompositionPeerReview(rev, r, tr, plan, d),
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
      if (!this.stopping && cfg.runId) await this.writeOwDeliverable(cfg);
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
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
          pickReflectionAgent: (m) => m.list().find((a) => a.index === 1) ?? null,
          buildReflectionContext: (s) =>
            `Orchestrator-worker preset · ${cfg.agentCount} agents (1 lead + workers) · ran ${s.round}/${cfg.rounds} cycles${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

  // 2026-05-02 (deliverables initiative): orchestrator-worker
  // structured artifact. Sections: lead's plan / per-worker findings /
  // lead's synthesis. Lead is index 1; workers are 2..N.
  private async writeOwDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective(cfg);
    const leadEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex === 1,
    );
    const workerEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex !== undefined && e.agentIndex !== 1,
    );
    // First lead entry = the plan; last lead entry = the synthesis.
    const planEntry = leadEntries[0]?.text?.trim() || "_(no plan captured)_";
    const synthesisEntry = leadEntries[leadEntries.length - 1]?.text?.trim() || "_(no synthesis captured)_";
    const sections: Array<{ title: string; body: string }> = [];
    const directiveSection = maybeDirectiveSection(dirCtx);
    if (directiveSection) sections.push(directiveSection);
    sections.push(
      {
        title: pickAnswerSectionTitle(dirCtx, {
          withDirective: "Answer to directive",
          withoutDirective: "Final synthesis (lead)",
        }),
        body: synthesisEntry,
      },
      { title: "Initial plan (lead)", body: planEntry },
      {
        title: `Per-worker findings (${workerEntries.length} entries)`,
        body: workerEntries.length > 0
          ? workerEntries.map((e) => `### Worker ${e.agentIndex}\n\n${e.text.trim()}`).join("\n\n")
          : "_(no worker findings)_",
      },
    );
    // 2026-05-02 (quality levers #1+#3): augment with critic + next-actions.
    const lead = this.opts.manager.list().find((a) => a.index === 1) ?? null;
    const augmented = await runQualityPasses({
      baseSections: sections,
      rubric: null,
      criticAgent: lead,
      manager: this.opts.manager,
    });
    const subtitleBase = `1 lead + ${cfg.agentCount - 1} worker${cfg.agentCount - 1 === 1 ? "" : "s"} across ${this.round}/${cfg.rounds} cycle${cfg.rounds === 1 ? "" : "s"}${this.earlyStopDetail ? " · early-stop" : ""}`;
    writeDeliverableAndEmit(
      {
        preset: "orchestrator-worker",
        runId: cfg.runId,
        clonePath: cfg.localPath,
        title: pickDeliverableTitle(dirCtx, {
          withDirective: "Orchestrator–worker: directive answer",
          withoutDirective: "Orchestrator–worker report",
        }),
        subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
        sections: augmented,
      },
      { transcript: this.transcript, emit: this.opts.emit },
    );

    // T2.2 (2026-05-04): opt-in wrap-up apply phase. Lead doubles as implementer.
    if (lead) {
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
            directive: cfg.userDirective ?? "Orchestrator-worker multi-writer synthesis",
            clonePath: cfg.localPath,
            model: cfg.writeModel ?? cfg.model,
            agent: lead,
            repos: this.opts.repos,
            manager: this.opts.manager,
            emit: this.opts.emit,
            appendSystem: (text) => this.appendSystem(text),
            presetName: "orchestrator-worker",
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
        presetName: "orchestrator-worker",
        agent: lead,
        manager: this.opts.manager,
        repos: this.opts.repos,
        emit: this.opts.emit,
        appendSystem: (text) => this.appendSystem(text),
      });
    }
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  private async runLeadTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    prompt: string,
    kind: "plan" | "synthesis",
  ): Promise<string> {
    return this.runAgent(agent, round, totalRounds, prompt, `lead-${kind}`);
  }

  private async runWorkerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    subtask: string,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    successCriteria?: string,
  ): Promise<void> {
    // 2026-05-02 (chat lever #3): per-worker @mention filter.
    const visibleSeed = seedSnapshot.filter((e) => userEntryVisibleTo(e, agent.id));
    const prompt = buildWorkerPrompt(
      agent.index,
      round,
      totalRounds,
      subtask,
      visibleSeed,
      userDirective,
      successCriteria,
    );
    await this.runAgent(agent, round, totalRounds, prompt, "worker");
  }

  // T195 (2026-05-04): scan THIS cycle's worker reports for HANDOFF
  // lines + dispatch a mini-wave to the named workers before
  // synthesis. Cap mini-wave at 3 handoffs to bound the cycle.
  // Track handoffs already dispatched to avoid duplicates within
  // the same cycle.
  private async dispatchHandoffWave(
    workers: Agent[],
    round: number,
    totalRounds: number,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    const HANDOFF_CAP = 3;
    // Look at agent entries from this cycle (newest-first scan, stop
    // at the most recent system "Cycle r/" announcement).
    const cycleStart = this.transcript.findIndex(
      (e) =>
        e.role === "system" &&
        e.text.includes(`Cycle ${round}/${totalRounds}`),
    );
    const cycleEntries =
      cycleStart >= 0 ? this.transcript.slice(cycleStart) : this.transcript;
    const allHandoffs: HandoffRequest[] = [];
    for (const e of cycleEntries) {
      if (e.role !== "agent" || e.agentIndex === undefined) continue;
      const handoffs = parseHandoffLines(e.text, e.agentIndex);
      allHandoffs.push(...handoffs);
      if (allHandoffs.length >= HANDOFF_CAP) break;
    }
    if (allHandoffs.length === 0) return;
    const capped = allHandoffs.slice(0, HANDOFF_CAP);
    this.appendSystem(
      `[T195 cross-worker handoff] ${capped.length} handoff(s) detected; dispatching mini-wave: ${capped.map((h) => `Worker ${h.fromIndex}→${h.targetIndex}`).join(", ")}.`,
    );
    await staggerStart(capped, (h) => {
      const target = workers.find((w) => w.index === h.targetIndex);
      if (!target) {
        this.appendSystem(
          `[T195] Worker ${h.fromIndex} requested handoff to Worker ${h.targetIndex} but that index isn't in this run's pool — skipped.`,
        );
        return Promise.resolve();
      }
      return this.runWorkerTurn(
        target,
        round,
        totalRounds,
        `[HANDOFF from Worker ${h.fromIndex}] ${h.request}`,
        seedSnapshot,
        userDirective,
        // Skip successCriteria for handoff turns — the request is
        // its own success bar.
      );
    });
  }

  // T182 (2026-05-04): peer review of the lead's decomposition. Fires
  // ONCE per cycle right after planning. Reviewer is a worker (not the
  // lead, to surface blind spots). Their flagged concerns land in the
  // transcript so subsequent agents can engage with them; we don't
  // block the cycle on the review (best-effort discovery).
  private async runDecompositionPeerReview(
    reviewer: Agent,
    round: number,
    totalRounds: number,
    plan: Plan,
    userDirective?: string,
  ): Promise<void> {
    if (this.stopping) return;
    const prompt = buildDecompositionReviewPrompt(plan, round, totalRounds, userDirective);
    try {
      await this.runAgent(reviewer, round, totalRounds, prompt, "decomposition-review");
    } catch (err) {
      this.appendSystem(`[OrchestratorWorkerRunner] [decomposition peer review]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runAgent(
    agent: Agent,
    _round: number,
    _totalRounds: number,
    prompt: string,
    _label: string,
  ): Promise<string> {
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
      // T-Item-AutoRoute (2026-05-04): when cfg.dynamicModelRoute is
      // set, swap the per-prompt model based on this agent's role
      // category (orchestrator → planner-tier; worker → worker-tier).
      // Falls back to agent.model when the cfg has no per-tier
      // overrides — net no-op for users who haven't set them.
      const totalAgents = this.active?.agentCount ?? 0;
      const dynamicModelOverride =
        this.active?.dynamicModelRoute && this.active?.model
          ? selectModelForRole(
              defaultRoleForIndex(
                this.active.preset,
                agent.index,
                totalAgents,
              ),
              {
                model: this.active.model,
                workerModel: this.active.workerModel,
                plannerModel: this.active.plannerModel,
                auditorModel: this.active.auditorModel,
              },
            )
          : undefined;
      // Unit 16: shared retry wrapper.
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = await promptWithFailoverAuto(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        // Unit 20: read-only tools for discussion presets.
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: describeSdkError,
        ...(dynamicModelOverride && dynamicModelOverride !== agent.model
          ? { modelOverride: dynamicModelOverride }
          : {}),
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
          // Improvement #4: per-agent first-prompt cold-start logging.
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          // Unit 40: live latency sample over WS for the UI sparkline.
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
        runner: "orchestrator-worker",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
        manager: this.opts.manager,
        signal: controller.signal,
        runId: this.active?.runId,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      // Task #54: retry on model silence (see CouncilRunner for detail).
      // Pattern 8: retry on junk-short single-token output too.
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(agent, prompt, "swarm-read", diagCtx);
        if (retryText !== null) text = retryText;
      }
      // Task #115: track Pattern 8 stuck-loop, warn on threshold.
      trackPostRetryJunk(text, {
        agentId: agent.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      // Task #43: if this agent's response parses as an assignments
      // envelope (lead's turn 1 shape), attach a structured summary
      // so the UI renders a glance line + bullet list instead of
      // raw JSON. Workers' free-text responses get no summary.
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        summary: parseAssignmentsSummary(stripped.finalText),
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      // Phase 2 (writeMode: multi): collect hunk proposals if multi-writer active
      if (this.multiWriter?.isActive()) {
        const proposalResult = this.multiWriter.addProposal(agent, stripped.finalText);
        if (!proposalResult.skipped && proposalResult.hunks.length > 0) {
          this.appendSystem(
            `[${agent.id}] proposed ${proposalResult.hunks.length} hunk(s) — collected for reconciliation.`
          );
        }
      }
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

// Re-exported from the helpers module for backward compat with any
// consumer that imports them from this file via barrel re-exports.
export type { Assignment, Plan, HandoffRequest } from "./orchestratorWorkerPromptHelpers.js";
export {
  parsePlan,
  buildLeadPlanPrompt,
  buildWorkerPrompt,
  buildLeadSynthesisPrompt,
  parseAssignmentsSummary,
  parseHandoffLines,
  summarizeEffortDistribution,
  buildDecompositionReviewPrompt,
} from "./orchestratorWorkerPromptHelpers.js";

