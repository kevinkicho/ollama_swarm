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
import { AgentStatsCollector } from "./agentStatsCollector.js";
import {
  buildDiscussionSummary,
  buildRunFinishedSummary,
  buildSeedSummary,
  formatPortReleaseLine,
  formatRunFinishedBanner,
  writeRunSummary,
} from "./runSummary.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { shouldHaltOnQuota, snapshotLifetimeTokens, tokenBudgetExceeded, tokenTracker } from "../services/ollamaProxy.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { staggerStart } from "./staggerStart.js";
import {
  parsePlan,
  buildWorkerPrompt,
  type Assignment,
} from "./OrchestratorWorkerRunner.js";
import { runEndReflection } from "./runEndReflection.js";

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

  injectUser(text: string): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
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
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model }));
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
    const seed = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      "Pattern: 3-tier orchestrator-worker (deep).",
      `  Tier 1 — orchestrator (agent 1)`,
      `  Tier 2 — ${t.midLeadIndices.length} mid-leads (agents ${t.midLeadIndices.join(", ")})`,
      `  Tier 3 — ${t.workerIndices.length} workers, partitioned across mid-leads`,
      "",
      "Per cycle: orchestrator dispatches one coarse subtask per mid-lead; each mid-lead breaks its subtask into worker subtasks; workers execute in parallel; mid-leads synthesize upward; orchestrator synthesizes the cycle.",
    ].join("\n");
    this.appendSystem(seed, buildSeedSummary(cfg.repoUrl, clonePath, tree));
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

      const tokenBaseline = snapshotLifetimeTokens();
      // Task #144: same consecutive-empty-plans guard as flat OW. The
      // orchestrator's prompt context grows even faster in deep mode
      // (mid-lead syntheses + cross-cycle history), so the same break
      // threshold applies.
      let consecutiveEmptyPlans = 0;
      const EMPTY_PLAN_BREAK_THRESHOLD = 2;

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        if (tokenBudgetExceeded(tokenBaseline, cfg.tokenBudget)) {
          this.earlyStopDetail = `token-budget reached (${cfg.tokenBudget?.toLocaleString()} tokens)`;
          this.appendSystem(
            `Token budget of ${cfg.tokenBudget?.toLocaleString()} tokens reached at cycle ${r - 1}/${cfg.rounds} — ending run early.`,
          );
          break;
        }
        // Task #137: quota-wall cap check.
        if (shouldHaltOnQuota()) {
          const q = tokenTracker.getQuotaState();
          this.earlyStopDetail = `ollama-quota-exhausted (${q?.statusCode}: ${q?.reason.slice(0, 100)})`;
          this.appendSystem(
            `Ollama quota wall hit at cycle ${r - 1}/${cfg.rounds} (${q?.statusCode}) — ending run early.`,
          );
          break;
        }
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        // Phase 1 — TOP-PLAN
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: orchestrator planning at top level.`);
        const topPlanText = await this.runAgent(
          orchestrator,
          buildTopPlanPrompt(r, cfg.rounds, liveMidLeads.map((m) => m.index), [...this.transcript]),
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
        if (topPlan.assignments.length === 0) {
          consecutiveEmptyPlans++;
          this.appendSystem(
            `Cycle ${r}: orchestrator produced no parseable mid-lead assignments — skipping execute phase this cycle. (consecutive=${consecutiveEmptyPlans})`,
          );
          if (consecutiveEmptyPlans >= EMPTY_PLAN_BREAK_THRESHOLD) {
            this.earlyStopDetail = `orchestrator-silenced (${consecutiveEmptyPlans} consecutive empty plans)`;
            this.appendSystem(
              `Orchestrator has produced empty plans for ${consecutiveEmptyPlans} consecutive cycles — ending OW-deep early to avoid burning wall-clock on dead loops.`,
            );
            break;
          }
          continue;
        }
        consecutiveEmptyPlans = 0;

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
          await this.runMidLeadSubtree(midLead, pool, a, r, cfg.rounds, seedSnapshot);
        });
        if (this.stopping) break;

        // Phase 5 — TOP-SYNTH
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: orchestrator synthesizing across mid-lead reports.`);
        await this.runAgent(
          orchestrator,
          buildTopSynthesisPrompt(r, cfg.rounds, [...this.transcript]),
        );
      }
      if (!this.stopping) this.appendSystem("Orchestrator-worker-deep run complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // Task #150: end-of-run reflection (orchestrator does it).
      if (!crashMessage && !this.stopping && cfg.runId) {
        const orch = this.opts.manager.list().find((a) => a.index === 1);
        if (orch && this.topology) {
          const ctxSummary = `Orchestrator-worker-deep · 1 orchestrator + ${this.topology.midLeadIndices.length} mid-leads + ${this.topology.workerIndices.length} workers · ran ${this.round}/${cfg.rounds} cycles${this.earlyStopDetail ? ` · early-stop: ${this.earlyStopDetail}` : ""}`;
          await runEndReflection({
            agent: orch, preset: cfg.preset, runId: cfg.runId, clonePath: cfg.localPath,
            contextSummary: ctxSummary, log: (msg) => this.appendSystem(msg),
          }).catch(() => {});
        }
      }
      await this.writeSummary(cfg, crashMessage);
      if (!this.stopping) {
        const killResult = await this.opts.manager.killAll();
        this.appendSystem(formatPortReleaseLine(killResult));
        this.setPhase("completed");
      }
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
      ),
    );
    if (this.stopping) return;
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
      return this.runWorkerForMidLead(w, midLead.index, round, totalRounds, a.subtask, seedSnapshot);
    });
    if (this.stopping) return;
    this.appendSystem(`[mid-lead ${midLead.index}] cycle ${round}: synthesizing worker reports upward.`);
    await this.runAgent(
      midLead,
      buildMidLeadSynthesisPrompt(midLead.index, round, totalRounds, coarseAssignment.subtask, [...this.transcript]),
    );
  }

  private async runWorkerForMidLead(
    worker: Agent,
    midLeadIndex: number,
    round: number,
    totalRounds: number,
    subtask: string,
    seedSnapshot: readonly TranscriptEntry[],
  ): Promise<void> {
    // Reuse flat OW's worker prompt — the worker's experience is the same
    // whether its assigner is a flat lead or a mid-lead. Tag the announcement
    // so the transcript shows the chain of command.
    const prompt = buildWorkerPrompt(worker.index, round, totalRounds, subtask, seedSnapshot);
    this.appendSystem(`[mid-lead ${midLeadIndex} → worker ${worker.index}] dispatching: ${truncate(subtask)}`);
    await this.runAgent(worker, prompt);
  }

  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(cfg.localPath);
    } catch {
      // best-effort
    }
    const summary = buildDiscussionSummary({
      config: {
        repoUrl: cfg.repoUrl,
        localPath: cfg.localPath,
        preset: cfg.preset,
        model: cfg.model,
        runId: cfg.runId,
      },
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      crashMessage,
      stopping: this.stopping,
      earlyStopDetail: this.earlyStopDetail,
      filesChanged: gitStatus.changedFiles,
      finalGitStatus: gitStatus.porcelain,
      agents: this.stats.buildPerAgentStats(),
      transcript: this.transcript,
    });
    try {
      await writeRunSummary(cfg.localPath, summary);
      this.appendSystem(formatRunFinishedBanner(summary), buildRunFinishedSummary(summary));
      this.appendSystem(
        `Wrote run summary (stopReason=${summary.stopReason}, wallClockMs=${summary.wallClockMs}, files=${summary.filesChanged}).`,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write run summary (${msg})`);
    }
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
    const ABSOLUTE_MAX_MS = 4 * 60_000;
    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);
    const controller = new AbortController();
    let abortedReason: string | null = null;
    const watchdog = setInterval(() => {
      if (Date.now() - turnStart > ABSOLUTE_MAX_MS) {
        abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s)`;
        controller.abort(new Error(abortedReason));
        void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
      }
    }, 10_000);
    try {
      const res = await promptWithRetry(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        agentName: "swarm-read",
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
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
        ts: Date.now(),
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
      const msg = abortedReason ?? describeSdkError(err);
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
      clearInterval(watchdog);
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
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  const midList = midLeadIndices.map((i) => `Agent ${i}`).join(", ");
  return [
    "You are the ORCHESTRATOR (top tier) of a 3-tier swarm.",
    `This is the planning phase of cycle ${round}/${totalRounds}.`,
    `Below you are ${midLeadIndices.length} MID-LEADS: ${midList}. Each manages its own pool of workers; you do NOT see workers directly.`,
    "Assign ONE coarse subtask per mid-lead — they will break it down further for their workers.",
    "",
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
      ? "start with broad coverage of the repo (e.g. one mid-lead per top-level directory or per system area)."
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
): string {
  const seedText = seedSnapshot.map((e) => `[SYSTEM] ${e.text}`).join("\n\n");
  const workerList = workerIndices.map((i) => `Agent ${i}`).join(", ");
  return [
    `You are MID-LEAD Agent ${midLeadIndex} in a 3-tier orchestrator-worker swarm.`,
    `This is cycle ${round}/${totalRounds}. The orchestrator just dispatched you a coarse subtask, and you have ${workerIndices.length} workers under you: ${workerList}.`,
    "",
    "=== YOUR COARSE SUBTASK FROM ORCHESTRATOR ===",
    coarseSubtask,
    "=== END COARSE SUBTASK ===",
    "",
    `Break the coarse subtask into ${workerIndices.length} fine-grained worker subtasks — one per worker — that COLLECTIVELY cover what the orchestrator asked.`,
    "Workers see only their fine subtask + the seed below; not your plan, not the orchestrator's plan, not peer worker reports. Subtasks must be self-contained.",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"assignments": [{"agentIndex": <worker-index>, "subtask": "…"}, …]}',
    "",
    "Rules:",
    "- One assignment per worker. Cover non-overlapping aspects.",
    "- Use file paths from the seed when relevant. Be concrete.",
    "- Subtask text under ~200 chars each. Workers should be able to act on them without further clarification.",
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
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  return [
    `You are MID-LEAD Agent ${midLeadIndex}. Your workers just reported on the subtasks you assigned them this cycle.`,
    `Cycle ${round}/${totalRounds}.`,
    "",
    "=== ORCHESTRATOR'S ORIGINAL COARSE SUBTASK TO YOU ===",
    coarseSubtask,
    "=== END ===",
    "",
    "Read every worker report in the transcript below. Produce a TIGHT synthesis (under ~250 words) directed UPWARD to the orchestrator. The synthesis should:",
    "- Summarize what your workers found, attributed to specific workers (e.g. \"Agent 5 noted…\").",
    "- Answer the coarse subtask the orchestrator gave you. Be honest about gaps your workers couldn't resolve.",
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
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  return [
    "You are the ORCHESTRATOR. Each mid-lead just reported back its synthesis of its workers' findings.",
    `Cycle ${round}/${totalRounds}.`,
    "",
    "Read every mid-lead synthesis in the transcript and produce the cycle's final synthesis (under ~400 words) that:",
    "1. Names what the project is and who it's for.",
    "2. Pulls together what's working / what's missing across all mid-lead reports.",
    "3. Proposes one concrete next action the swarm should take, citing which mid-lead's findings drove it.",
    round < totalRounds
      ? "4. Flags ONE gap or inconsistency across mid-lead reports that a future cycle should investigate."
      : "4. Closes with a final recommendation now that this is the last cycle.",
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

function describeSdkError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    let depth = 0;
    while (cause && depth < 4) {
      if (cause instanceof Error) {
        const code = (cause as { code?: string }).code;
        parts.push(code ? `${cause.message} [${code}]` : cause.message);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(String(cause));
        cause = undefined;
      }
      depth++;
    }
    return parts.join(" <- ");
  }
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(o).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}

function truncate(s: string, max: number = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
