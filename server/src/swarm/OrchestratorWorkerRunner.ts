import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import { buildAgentsReadySummary } from "./agentsReadySummary.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
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
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
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
export class OrchestratorWorkerRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase B (Task #101): set when lead emits `done: true` in its plan
  // for a cycle. Promoted to stopReason="early-stop" by writeSummary.
  private earlyStopDetail?: string;

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
      // Task #39: per-agent partial-stream buffer for catch-up.
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
    // Task #34: see BlackboardRunner.isRunning() — terminal phases
    // are not running.
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

    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    const { destPath } = cloneResult;
    // Unit 47: tell the UI whether this is a fresh clone or a resume.
    this.opts.emit({
      type: "clone_state",
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    });
    // Unit 48: hide runner artifacts from `git status` (see RoundRobinRunner).
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    // E3 Phase 5: opencode.json no longer needed.
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnStart = Date.now();
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgentNoOpencode({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length === 0) throw new Error("No agents started successfully");
    if (ready.length < 2) throw new Error("Orchestrator–worker needs at least 1 lead + 1 worker (agentCount >= 2)");
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. Agent 1 is the LEAD; agents 2..${cfg.agentCount} are WORKERS.`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: "orchestrator-worker",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: (a) => (a.index === 1 ? "Lead" : "Worker"),
      }),
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
        const planText = await this.runLeadTurn(
          lead,
          r,
          cfg.rounds,
          buildLeadPlanPrompt(r, cfg.rounds, workers.map((w) => w.index), [...this.transcript], cfg.userDirective),
          "plan",
        );
        if (this.stopping) break;

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
      // Unit 16: shared retry wrapper.
      const res = await promptWithRetry(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        // Unit 20: read-only tools for discussion presets.
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
    // thinkingSince REST-snapshot fix: route through the manager so
    // the agentStates mirror gets updated in lockstep with the WS
    // broadcast. See AgentManager.recordAgentState.
    this.opts.manager.recordAgentState(s);
  }
}

export interface Assignment {
  agentIndex: number;
  subtask: string;
  /** T175 (2026-05-04): per-subtask "how I'll know this worker
   *  succeeded" rubric. The lead writes one short sentence describing
   *  the shape of a successful report; the worker self-evaluates
   *  against it before reporting. Optional for backward-compat — old
   *  plan responses without successCriteria still parse cleanly. */
  successCriteria?: string;
  /** T182 (2026-05-04): per-subtask effort estimate. The lead rates
   *  difficulty as small | medium | large so the runner could load-
   *  balance — today it just surfaces in the system bubble so the
   *  reader can spot lopsided plans. Optional for backward-compat. */
  effort?: "small" | "medium" | "large";
}

export interface Plan {
  assignments: Assignment[];
  // Phase B (Task #101): lead can short-circuit the loop by setting
  // done:true. Means "no useful work remains; stop now". Independent
  // of `assignments` — done:true with assignments=[] is the canonical
  // shape, but if the model still emits assignments alongside, we
  // honor done:true and skip them.
  done?: boolean;
}

// Exported for testability. Accepts either a clean JSON object with
// `assignments: [{agentIndex, subtask}]` or a JSON object wrapped in a
// markdown fence. Silently drops malformed assignments. Filters out any
// agentIndex not in the allowed worker set (so a confused lead can't
// assign work to itself or to a non-spawned worker).
export function parsePlan(raw: string, allowedWorkerIndices: readonly number[]): Plan {
  const allowed = new Set(allowedWorkerIndices);
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try to find the first {...} JSON-looking block
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return { assignments: [] };
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return { assignments: [] };
    }
  }
  if (!parsed || typeof parsed !== "object") return { assignments: [] };
  const doneRaw = (parsed as { done?: unknown }).done;
  const done = doneRaw === true ? true : undefined;
  const assignmentsRaw = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignmentsRaw)) return { assignments: [], done };
  const assignments: Assignment[] = [];
  const seenAgents = new Set<number>();
  for (const a of assignmentsRaw) {
    if (!a || typeof a !== "object") continue;
    const idx = (a as { agentIndex?: unknown }).agentIndex;
    const subtask = (a as { subtask?: unknown }).subtask;
    const successCriteriaRaw = (a as { successCriteria?: unknown }).successCriteria;
    const effortRaw = (a as { effort?: unknown }).effort;
    if (typeof idx !== "number" || !allowed.has(idx)) continue;
    if (typeof subtask !== "string" || subtask.trim().length === 0) continue;
    if (seenAgents.has(idx)) continue; // one subtask per worker per cycle
    seenAgents.add(idx);
    // T175: extract optional successCriteria. Empty/missing → undefined,
    // worker prompt skips the rubric block. String values get trimmed.
    const successCriteria =
      typeof successCriteriaRaw === "string" && successCriteriaRaw.trim().length > 0
        ? successCriteriaRaw.trim()
        : undefined;
    // T182: extract optional effort. Whitelist against catalog so a
    // model emitting "huge" or "tiny" doesn't poison the field.
    const effortLower =
      typeof effortRaw === "string" ? effortRaw.trim().toLowerCase() : "";
    const effort =
      effortLower === "small" || effortLower === "medium" || effortLower === "large"
        ? (effortLower as "small" | "medium" | "large")
        : undefined;
    assignments.push({
      agentIndex: idx,
      subtask: subtask.trim(),
      ...(successCriteria ? { successCriteria } : {}),
      ...(effort ? { effort } : {}),
    });
  }
  return { assignments, done };
}

export function buildLeadPlanPrompt(
  round: number,
  totalRounds: number,
  workerIndices: readonly number[],
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

  const workerList = workerIndices.map((i) => `Agent ${i}`).join(", ");

  // 2026-05-02 (OW directive lever): when a directive is set the
  // plan must DECOMPOSE the directive into worker subtasks. Each
  // subtask should advance the directive, not just describe a slice
  // of the repo. The "rules for good subtasks" guidance is augmented
  // accordingly.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this OW swarm is answering)",
    framingLines: [
      "Your job is to DECOMPOSE the directive into worker subtasks. Each subtask should produce a piece of the answer (a finding, a proposal, an investigation). Do NOT dispatch generic 'inspect this dir' subtasks unless that inspection directly bears on the directive.",
    ],
  });
  // Local alias for branches further down.
  const directive = dirCtx.directive;

  return [
    `You are the LEAD agent in an orchestrator–worker swarm inspecting a cloned GitHub project.`,
    `This is planning phase of cycle ${round}/${totalRounds}.`,
    `Your workers are: ${workerList}. Assign ONE subtask to each — workers execute in parallel with no visibility of each other.`,
    "",
    ...directiveBlock,
    // Task #83 (2026-04-25): repo-grounding for subtask quality.
    // Mirror of the planner-grounding rule from #69 (blackboard).
    // Lead frequently dispatches workers to inspect things that
    // don't exist in the codebase ("audit src/utils/" when there's
    // no utils dir). Forcing a tool-call pass before assignments
    // dramatically reduces wasted worker cycles.
    "REQUIRED VERIFICATION (Task #83) — BEFORE writing assignments:",
    "  - Use `list` / `glob` / `read` tools on the cloned repo to confirm the directories and files you intend to dispatch workers to ACTUALLY EXIST.",
    "  - If you assume a path (e.g. `src/utils/`, `tests/`, `docs/`) that turns out to not exist, the worker will return a 'not found' report and burn the cycle.",
    "  - Cheapest verification: read README.md + a top-level `list` first. Then assign workers to paths that appeared in those listings.",
    "",
    "Output ONLY a JSON object with this shape (no prose, no markdown fences):",
    '{"done": false, "assignments": [{"agentIndex": 2, "subtask": "…", "successCriteria": "…", "effort": "small|medium|large"}, …]}',
    "",
    // T175 (2026-05-04): per-subtask successCriteria. Sets a clear bar
    // the worker self-evaluates against before reporting.
    "**successCriteria** is a one-sentence rubric for what a SUCCESSFUL worker report looks like.",
    "  Examples:",
    "    \"Report names every call site of X.foo() with file:line citations.\"",
    "    \"Report identifies whether the auth flow uses JWT or sessions, with file evidence.\"",
    "    \"Report concludes with a clear PROPOSE: <new shape> line backed by current code.\"",
    "  Skip the field (or empty string) for genuinely open-ended subtasks. Most subtasks should have one.",
    "",
    // T182 (2026-05-04): per-subtask effort estimate. small|medium|large
    // so the reader can spot lopsided plans (3 large + 1 small = the
    // small worker will idle while the large ones grind). Future
    // runner work can use this for actual load-balancing.
    "**effort** is your difficulty estimate for the subtask:",
    "    small  — tightly scoped, one file or one function (e.g. \"list every call site of X\")",
    "    medium — multi-file investigation or multi-step reasoning (e.g. \"map auth flow end-to-end\")",
    "    large  — open-ended exploration or many files (e.g. \"propose new module shape\")",
    "  Skip the field for genuinely uncertain estimates.",
    "",
    // Phase B (Task #101): early-stop signal. The lead can short-
    // circuit the loop when there is genuinely nothing useful left
    // to dispatch — e.g. every prior worker reported "no further
    // changes needed" or the prior synthesis already covered the
    // remaining gaps. Be honest: if any meaningful gap remains,
    // dispatch to investigate it.
    'Set `done: true` (with assignments: []) ONLY when one of these holds:',
    "  • All workers in the prior cycle returned NO_CHANGE / nothing-new / no-issues-found.",
    "  • The prior synthesis explicitly stated a complete, satisfactory picture and there is no remaining gap to investigate.",
    "Otherwise set `done: false` and dispatch real subtasks. On cycle 1, `done` MUST be false — there's nothing yet to be done about.",
    "",
    "Rules for good subtasks:",
    "- Each subtask is self-contained (the worker sees only its subtask + the seed; no peer context, no your planning text).",
    directive.length > 0
      ? "- Subtasks DECOMPOSE THE DIRECTIVE: each one investigates / proposes / verifies a different piece of the answer. Cite the real paths you verified above. Examples (for a 'refactor X' directive): \"map every call site of X.foo() and report file:line list\", \"propose the new API shape for X based on src/x.ts\", \"identify tests that cover X today and gaps that need new ones\"."
      : "- Subtasks should DIVIDE LABOR: e.g. \"inspect src/foo/\", \"read README and package.json\", \"inspect src/__tests__/ and note coverage\", \"audit dependencies in package.json\". Avoid duplicate assignments. Reference REAL paths you verified above.",
    "- Keep subtask text under ~200 chars. Be specific about what to report back.",
    "- One assignment per worker. Do NOT assign more than one subtask to the same agent.",
    round > 1
      ? "- This is a later cycle: you have prior cycle syntheses in the transcript. Use them to refine — dispatch workers to fill gaps the prior synthesis surfaced."
      : directive.length > 0
        ? "- This is cycle 1: dispatch workers to gather the FOUNDATIONAL evidence the directive needs answered. Verify the top-level structure with `list .` first so your dispatched paths are real."
        : "- This is cycle 1: start with broad coverage of the repo. Verify the top-level structure with `list .` first so your dispatched paths are real.",
    "",
    "=== TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — this is the first planning step)",
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

export function buildWorkerPrompt(
  workerIndex: number,
  round: number,
  totalRounds: number,
  subtask: string,
  seedSnapshot: readonly TranscriptEntry[],
  userDirective?: string,
  successCriteria?: string,
): string {
  const seedText = seedSnapshot
    .map((e) => `[SYSTEM] ${e.text}`)
    .join("\n\n");

  // 2026-05-02 (OW directive lever): worker sees the directive as
  // context for WHY their subtask matters. Same anti-hallucination
  // valve as map-reduce: if the worker concludes the subtask doesn't
  // bear on the directive after investigation, that's a valid honest
  // answer — better than inventing relevance to seem useful.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this OW swarm is answering)",
    framingLines: [
      "Your subtask below is the lead's decomposition of one piece of the directive. Execute it, then report findings RELEVANT TO THE DIRECTIVE.",
      "**\"NO RELEVANT FINDINGS\" IS A VALID ANSWER.** If your subtask turns out to have no bearing on the directive (the lead may have over-decomposed), say so honestly: `My subtask <X> turned up no findings relevant to the directive: <one-line why>`. Do NOT invent relevance to seem useful.",
    ],
  });

  // T175 (2026-05-04): per-subtask success criteria block. When the
  // lead set a rubric for this subtask, surface it to the worker AND
  // require a self-evaluation line before the report. The lead's
  // synthesis can use the self-eval to weight reports.
  const rubricBlock = successCriteria
    ? [
        "",
        "**SUCCESS CRITERIA (rubric set by the lead):**",
        successCriteria,
        "",
        "BEFORE your report, write a one-line self-evaluation:",
        "    SELF-EVAL: PASS — <why your report meets the criteria>",
        "    SELF-EVAL: PARTIAL — <which part is met, which isn't, why>",
        "    SELF-EVAL: MISS — <why you couldn't meet it; what's blocking>",
        "Be honest — a clear PARTIAL/MISS is more useful to the lead than a falsely-claimed PASS.",
        "",
      ]
    : [];

  return [
    `You are Worker Agent ${workerIndex} in an orchestrator–worker swarm.`,
    `This is cycle ${round}/${totalRounds}. You cannot see the lead's full plan or any peer worker's output — that is deliberate, so your report is independent.`,
    "",
    ...directiveBlock,
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "Respond with a CONCRETE report (under ~300 words) of what you found, citing file paths (e.g. `src/foo.ts:42`) where relevant.",
    "Do NOT try to coordinate with other workers or ask for more scope — just execute your subtask and report.",
    ...rubricBlock,
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
    "",
    "YOUR SUBTASK:",
    subtask,
    "",
    `Now respond as Worker Agent ${workerIndex}.`,
  ].join("\n");
}

export function buildLeadSynthesisPrompt(
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

  // 2026-05-02 (OW directive lever): when a directive is set the
  // synthesis answers the directive directly using worker findings as
  // evidence, instead of producing the generic "what is this project"
  // recap.
  if (dirCtx.hasDirective) {
    const closing = isFinal
      ? "4. **Final recommendation** — your one concrete next step toward the directive. Cite worker findings + file paths."
      : "4. **Coverage gap toward the directive** — name one piece the workers couldn't answer that next cycle's plan should target.";
    return [
      `You are the LEAD agent in an orchestrator–worker swarm.`,
      `This is the synthesis phase of cycle ${round}/${totalRounds}. Your workers have just reported back on the subtasks you assigned.`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the question this OW swarm is answering)",
      }),
      "Read every worker report in the transcript below. Produce a synthesis (under ~500 words) structured as:",
      "1. **Answer to directive** — direct response built from worker findings. Cite the workers + file paths that ground each claim.",
      "2. **Supporting evidence** — list the specific worker findings that make the answer hold up.",
      "3. **Tensions / open questions** — places where worker reports disagreed or couldn't answer. Be honest about confidence.",
      closing,
      "",
      "Cite workers by index (e.g. \"Agent 3 noted…\") when referencing their findings. Do NOT invent evidence not in a worker report — if the directive can't be answered from what workers gathered, say so explicitly.",
      "",
      "=== TRANSCRIPT ===",
      transcriptText,
      "=== END TRANSCRIPT ===",
      "",
      "Now write your synthesis.",
    ].join("\n");
  }

  return [
    `You are the LEAD agent in an orchestrator–worker swarm.`,
    `This is the synthesis phase of cycle ${round}/${totalRounds}. Your workers have just reported back on the subtasks you assigned.`,
    "",
    "Read every worker report in the transcript below. Produce a synthesis (under ~400 words) that:",
    "1. Names what the project is and who it seems to be for.",
    "2. Summarizes what's working and what's missing, drawing from worker reports.",
    "3. Proposes one concrete next action the swarm should take, with a rationale citing worker findings.",
    isFinal
      ? "4. Closes with a final recommendation now that this is the last cycle."
      : "4. Notes one gap or inconsistency across worker reports that a future cycle should investigate.",
    "",
    "Cite workers by index (e.g. \"Agent 3 noted…\") when referencing their findings. Do not re-invent evidence not in a worker report.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis.",
  ].join("\n");
}


// Task #43: parse an orchestrator "assignments" envelope into a
// structured summary the transcript UI can render inline. Accepts a
// fenced ```json``` block OR a bare object. Returns undefined when
// the text isn't an assignments envelope (e.g. worker free-text
// response, lead synthesis pass). The summary carries enough for
// the UI to render a one-line summary + bullet-list expansion.
function parseAssignmentsSummary(text: string): TranscriptEntrySummary | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Strip a ```json ... ``` fence if present.
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  if (candidate.charAt(0) !== "{") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as { assignments?: unknown };
  if (!Array.isArray(obj.assignments)) return undefined;
  const assignments: Array<{ agentIndex: number; subtask: string }> = [];
  for (const item of obj.assignments) {
    if (!item || typeof item !== "object") continue;
    const it = item as { agentIndex?: unknown; subtask?: unknown };
    if (typeof it.agentIndex !== "number") continue;
    if (typeof it.subtask !== "string") continue;
    assignments.push({ agentIndex: it.agentIndex, subtask: it.subtask });
  }
  if (assignments.length === 0) return undefined;
  return {
    kind: "ow_assignments",
    subtaskCount: assignments.length,
    assignments,
  };
}

// T182 (2026-05-04): summarize the effort distribution of a plan as
// one-line system bubble text. Returns null when no assignments
// carry effort tags (back-compat: old plans don't have effort).
export function summarizeEffortDistribution(
  assignments: readonly Assignment[],
): string | null {
  let small = 0;
  let medium = 0;
  let large = 0;
  let untagged = 0;
  for (const a of assignments) {
    if (a.effort === "small") small++;
    else if (a.effort === "medium") medium++;
    else if (a.effort === "large") large++;
    else untagged++;
  }
  if (small + medium + large === 0) return null;
  const parts: string[] = [];
  if (small > 0) parts.push(`${small} small`);
  if (medium > 0) parts.push(`${medium} medium`);
  if (large > 0) parts.push(`${large} large`);
  if (untagged > 0) parts.push(`${untagged} untagged`);
  // Lopsided plans (every assignment is large or every is small) are
  // worth flagging — workers will idle while the heavy ones grind.
  const total = small + medium + large + untagged;
  let lopsided = "";
  if (large >= 2 && small + medium === 0) lopsided = " · LOPSIDED (all large — workers may idle if they finish at different speeds)";
  else if (small >= 2 && medium + large === 0) lopsided = " · LOPSIDED (all small — possibly under-utilizing the cycle)";
  return `${total} subtask${total === 1 ? "" : "s"}: ${parts.join(", ")}${lopsided}`;
}

// T182 (2026-05-04): build a peer-review prompt asking another agent
// to flag obvious issues with the lead's decomposition BEFORE workers
// fire. Reviewer reads the JSON plan as text + asserts whether each
// subtask makes sense, has clear successCriteria, points at real
// paths, etc. Output goes to the transcript so subsequent agents see
// any flagged concerns; the runner doesn't act on them automatically
// (lead can refine in next cycle).
export function buildDecompositionReviewPrompt(
  plan: Plan,
  round: number,
  totalRounds: number,
  userDirective?: string,
): string {
  const directiveLine = userDirective?.trim()
    ? `User directive: ${userDirective.trim()}\n`
    : "";
  const assignmentsRendered = plan.assignments
    .map((a, i) => {
      const lines: string[] = [
        `**Subtask ${i + 1}** → Agent ${a.agentIndex}`,
        `  task: ${a.subtask}`,
      ];
      if (a.successCriteria) lines.push(`  successCriteria: ${a.successCriteria}`);
      if (a.effort) lines.push(`  effort: ${a.effort}`);
      return lines.join("\n");
    })
    .join("\n\n");
  return [
    `You are a PEER REVIEWER on an orchestrator–worker swarm. The lead just produced a plan for cycle ${round}/${totalRounds}; before workers fire, you flag obvious issues.`,
    "",
    directiveLine,
    "Plan to review:",
    assignmentsRendered,
    "",
    "Your job — answer these explicitly (under 200 words total):",
    "1. **Coverage** — does the plan cover the directive? What dimensions are missing?",
    "2. **Subtask clarity** — are any subtasks too vague to execute? Name them.",
    "3. **successCriteria** — are the rubrics tight enough that a worker could honestly self-evaluate? Flag fuzzy ones.",
    "4. **Effort balance** — are the effort tags realistic? Will small workers sit idle while large ones grind?",
    "5. **Real paths** — do the subtasks reference paths that actually exist (you can use file-read / list / glob tools to verify)?",
    "",
    "Be concrete. Cite subtask numbers when flagging. If the plan looks sound, say so directly — don't manufacture concerns.",
    "End your review with one of:",
    "  REVIEW VERDICT: PROCEED — plan is sound, workers should fire.",
    "  REVIEW VERDICT: CAUTION — concerns flagged above; workers should still fire but the lead's next cycle should address them.",
    "  REVIEW VERDICT: REJECT — plan has fundamental issues; recommend the lead re-plan before workers fire.",
    "",
    "(The runner currently surfaces your verdict to the transcript but doesn't act on REJECT — it's informational. Future work may auto-replan on REJECT.)",
  ].join("\n");
}
