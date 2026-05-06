import { randomUUID } from "node:crypto";
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
import { defaultRoleForIndex } from "../../../shared/src/topology.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { staggerStart } from "./staggerStart.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import {
  readDirective,
  buildDirectiveBlock,
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
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.stats.reset();

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
    void this.loop(cfg);
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    // 2026-05-02 (OW directive lever): the lead's plan becomes
    // "decompose the directive into worker subtasks" instead of
    // "tell me about this repo via N lenses". Workers get the
    // directive as context so off-topic findings can be filtered
    // honestly (same valve as map-reduce #1).
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "The lead decomposes the directive into worker subtasks; workers execute in parallel toward the directive; lead synthesizes a directive answer at the end.",
        ],
      }),
      "Pattern: Orchestrator–worker. Agent 1 is the LEAD; other agents are WORKERS.",
      "Lead will produce a plan (one subtask per worker), workers will execute in parallel with no visibility of peers, then lead will synthesize.",
    ];
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const lead = agents.find((a) => a.index === 1);
      const workers = agents.filter((a) => a.index !== 1);
      if (!lead) throw new Error("lead agent (index 1) did not spawn");
      if (workers.length === 0) throw new Error("no workers spawned");

      // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
      const tokenBaseline = snapshotLifetimeTokens();
      const planEmptyGuard = new PlanEmptyDeadLoopGuard({
        roleLabel: "lead",
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

        // PLAN — lead gets the full transcript (including any prior cycles'
        // syntheses) and produces a fresh plan.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: lead planning.`);
        let planText = await this.runLeadTurn(
          lead,
          r,
          cfg.rounds,
          buildLeadPlanPrompt(r, cfg.rounds, workers.map((w) => w.index), [...this.transcript], cfg.userDirective),
          "plan",
        );
        if (this.stopping) break;

        if (cfg.postSynthesisCritique && planText) {
          const proposals = this.transcript
            .filter(e => e.role === "agent" && e.agentIndex !== 1)
            .slice(-3)
            .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
          planText = await runPostSynthesisCritique({
            synthesis: planText,
            proposals,
            criticAgent: workers[0] ?? lead,
            manager: this.opts.manager,
            appendSystem: (text) => this.appendSystem(text),
            stopping: this.stopping,
            runDiscussionAgent: (agent, prompt, opts) => this.runDiscussionAgent(agent, prompt, opts),
            stats: this.stats,
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
          this.earlyStopDetail = `lead-reports-done after cycle ${r}/${cfg.rounds}`;
          this.appendSystem(
            `Lead reports done — ending OW early at cycle ${r}/${cfg.rounds}.`,
          );
          break;
        }
        // 2026-05-03 (Phase B): plan-empty guard extracted to shared class.
        const planHit = planEmptyGuard.recordCycle(plan.assignments);
        if (plan.assignments.length === 0) {
          this.appendSystem(
            `Cycle ${r}: lead produced no parseable assignments — skipping execute phase this cycle. Raw lead output preserved in transcript. (consecutive=${planHit.consecutive})`,
          );
          if (planHit.tripped) {
            this.earlyStopDetail = planHit.earlyStopDetail;
            this.appendSystem(
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
        const efforts = summarizeEffortDistribution(plan.assignments);
        if (efforts) this.appendSystem(`[T182 effort distribution] ${efforts}`);
        // Peer review: pick the lowest-index worker (NOT the lead, NOT
        // the worker assigned to the same subtask we're reviewing) and
        // ask them to flag obvious issues with the plan. Best-effort:
        // any failure is logged + ignored — workers still fire.
        if (workers.length >= 2) {
          await this.runDecompositionPeerReview(
            workers[0]!,
            r,
            cfg.rounds,
            plan,
            cfg.userDirective,
          );
        }

        // EXECUTE — workers fire in parallel. Each sees ONLY its assigned
        // subtask + the seed, not the full transcript or peer reports.
        // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED. v4
        // battle test showed it didn't help OW (same 50% success vs
        // worse) — the parallel cold-start ceiling applied to the warmup
        // batch too. OW relies on serial spawn-warmup from start() only.
        const seedSnapshot = this.transcript.filter((e) => e.role === "system");
        // Task #53: stagger the N parallel worker prompts to avoid the
        // Pattern 3 cold-start queue race confirmed in 2026-04-24 logs.
        await staggerStart(plan.assignments, (a) => {
          const w = workers.find((x) => x.index === a.agentIndex);
          if (!w) return Promise.resolve();
          return this.runWorkerTurn(
            w,
            r,
            cfg.rounds,
            a.subtask,
            seedSnapshot,
            cfg.userDirective,
            a.successCriteria,
          );
        });
        if (this.stopping) break;

        // T195 (2026-05-04): cross-worker handoffs. Scan worker reports
        // from THIS cycle for HANDOFF lines + dispatch a mini-wave to
        // the named workers BEFORE synthesis. Best-effort: handoff
        // failure doesn't block synthesis. Only one mini-wave per
        // cycle (handoffs from the mini-wave itself are deferred to
        // the next cycle to bound runaway re-dispatch).
        if (!this.stopping) {
          await this.dispatchHandoffWave(workers, r, cfg.rounds, seedSnapshot, cfg.userDirective);
        }
        if (this.stopping) break;

        // SYNTHESIZE — lead sees the full transcript again (now including
        // all worker reports from this cycle) and produces a consolidated
        // answer for the cycle.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: lead synthesizing.`);
        await this.runLeadTurn(
          lead,
          r,
          cfg.rounds,
          buildLeadSynthesisPrompt(r, cfg.rounds, [...this.transcript], cfg.userDirective),
          "synthesis",
        );

        if (cfg.postRoundCritique) {
          await maybeRunPostRoundCritique({
            agents: this.opts.manager.list(),
            round: this.round,
            totalRounds: cfg.rounds,
            transcript: this.transcript,
            userDirective: cfg.userDirective,
            enabled: cfg.postRoundCritique ?? false,
            runDiscussionAgent: (agent, prompt, opts) => this.runDiscussionAgent(agent, prompt, opts),
            stats: this.stats,
            appendSystem: (text, summary) => this.appendSystem(text, summary),
            presetName: "orchestrator-worker",
            stopping: this.stopping,
          });
        }
      }
      if (!this.stopping) this.appendSystem("Orchestrator–worker run complete.");
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
        emitOutcome: (outcome: any) => this.opts.emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions }),
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
    } catch {
      // best-effort — review failure shouldn't stop workers
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

