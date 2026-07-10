// DiscussionRunnerBase — shared base class for the 8 discussion-preset
// runners (council, round-robin, debate-judge, map-reduce, MoA,
// stigmergy, orchestrator-worker, orchestrator-worker-deep).
//
// Provides the common methods that every discussion runner needs:
//   injectUser, isRunning, status, appendSystem, setPhase, emitAgentState, stop,
//   resetState, initCloneAndSpawn, runDiscussionAgent
//
// Subclasses extend this instead of re-implementing these methods.
// BlackboardRunner has its own (more complex) implementations and
// does NOT extend this base.

import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { formatChatReceipt } from "./chatReceipt.js";
import { formatPortReleaseLine } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import type { RunAgentOpts } from "./postRoundCritiqueTypes.js";
import { type ToolTraceEntry } from "./toolCallTranscript.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import type { SwarmControlAdviceRecord } from "@ollama-swarm/shared/swarmControl/controlAdvice";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import type { ToolResultHook } from "../tools/ToolDispatcher.js";
import { runDiscussionAgentCore } from "./discussionRunAgent.js";
import {
  initCloneAndSpawn as initCloneAndSpawnExtracted,
  type CloneSpawnOpts,
  type CloneSpawnResult,
} from "./discussionInitClone.js";
import {
  runDiscussionLoop as runDiscussionLoopExtracted,
  checkRoundBudget as checkRoundBudgetExtracted,
  type DiscussionLoopCloseOutHooks,
} from "./discussionLoop.js";
import { startDiscussionWallClockWatchdog } from "./discussionWallClock.js";
import { drainIneligibleReason } from "@ollama-swarm/shared/drainEligibility.js";

export type { CloneSpawnOpts, CloneSpawnResult } from "./discussionInitClone.js";
export { type RunAgentOpts } from "./postRoundCritiqueTypes.js";

export abstract class DiscussionRunnerBase {
  protected transcript: TranscriptEntry[] = [];
  protected phase: SwarmPhase = "idle";
  protected round = 0;
  protected stopping = false;
  protected active?: RunConfig;
  protected summaryWritten = false;
  protected earlyStopDetail?: string;
  protected startedAt?: number;
  protected stats = new AgentStatsCollector();
  /** Buffered onTool callbacks; attached to the next agent transcript entry. */
  protected pendingToolTraceByAgent = new Map<string, ToolTraceEntry[]>();
  /** Sleep-safe wall-clock watchdog stop handle (discussion presets). */
  private wallClockWatchdogStop?: () => void;
  /** Token baseline for status remaining-budget display. */
  protected tokenBaselineForStatus?: number;

  constructor(protected readonly opts: RunnerOpts) {}

  /** Optional swarm control center — Council overrides to enable tool coach. */
  protected getSwarmControl(): SwarmControlCenter | undefined {
    return undefined;
  }

  /** Agent used for bounded tool-coach LLM calls (defaults to discussion agent). */
  protected getCoachAgent(_agent: Agent): Agent | undefined {
    return undefined;
  }

  protected getControlAdviceHistory(): SwarmControlAdviceRecord[] | undefined {
    const h = this.getSwarmControl()?.getAdviceHistory();
    return h && h.length > 0 ? [...h] : undefined;
  }

  private buildDiscussionToolCoachHook(agent: Agent): ToolResultHook | undefined {
    const control = this.getSwarmControl();
    const coach = this.getCoachAgent(agent) ?? agent;
    if (!control) return undefined;
    return (info) => {
      if (info.ok) return;
      control.recordToolFailure(agent.id, info.tool, info.error ?? "tool error", info.preview, {
        agent: coach,
        clonePath: this.active?.localPath,
        runId: this.active?.runId,
        appendSystem: (msg) => this.appendSystem(msg),
        emit: (e) => this.opts.emit(e),
      });
    };
  }

  // --- Shared methods (identical across all 8 discussion runners) ---

  status(): SwarmStatus {
    // Discussion presets are never soft-drain eligible (no worker claims).
    const drainInput = {
      phase: this.phase,
      claimed: 0,
      pendingCommit: 0,
    };
    const wallCap = this.active?.wallClockCapMs;
    let wallClockMsRemaining: number | undefined;
    if (wallCap && wallCap > 0 && this.startedAt != null) {
      wallClockMsRemaining = Math.max(0, wallCap - (Date.now() - this.startedAt));
    }
    let tokenBudgetRemaining: number | undefined;
    if (this.active?.tokenBudget && this.tokenBaselineForStatus != null) {
      const spent = Math.max(0, snapshotLifetimeTokens() - this.tokenBaselineForStatus);
      tokenBudgetRemaining = Math.max(0, this.active.tokenBudget - spent);
    }
    return {
      phase: this.phase,
      round: this.round,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: this.opts.manager.toStates(),
      transcript: [...this.transcript],
      streaming: this.opts.manager.getPartialStreams(),
      drainEligible: false,
      drainIneligibleReason: drainIneligibleReason(drainInput),
      earlyStopDetail: this.earlyStopDetail,
      runStartedAt: this.startedAt,
      runConfig: this.active
        ? {
            preset: this.active.preset,
            plannerModel: this.active.plannerModel ?? this.active.model,
            workerModel: this.active.workerModel ?? this.active.model,
            auditorModel:
              this.active.auditorModel ?? this.active.plannerModel ?? this.active.model,
            dedicatedAuditor: this.active.dedicatedAuditor === true,
            repoUrl: this.active.repoUrl,
            clonePath: this.active.localPath,
            agentCount: this.active.agentCount,
            rounds: this.active.rounds,
            wallClockCapMin: wallCap
              ? Math.round(wallCap / 60_000).toString()
              : undefined,
            ...(this.active.userDirective?.trim()
              ? { userDirective: this.active.userDirective.trim() }
              : {}),
          }
        : undefined,
      ...(wallClockMsRemaining != null || tokenBudgetRemaining != null
        ? {
            capsRemaining: {
              ...(wallClockMsRemaining != null ? { wallClockMsRemaining } : {}),
              ...(tokenBudgetRemaining != null ? { tokenBudgetRemaining } : {}),
            },
          }
        : {}),
    };
  }

  /** Start sleep-safe wall-clock watchdog when cfg.wallClockCapMs is set. */
  protected startDiscussionWallClockIfConfigured(cfg: RunConfig): void {
    this.stopDiscussionWallClock();
    if (!cfg.wallClockCapMs || cfg.wallClockCapMs <= 0) return;
    this.wallClockWatchdogStop = startDiscussionWallClockWatchdog({
      getStartedAt: () => this.startedAt,
      getWallClockCapMs: () => this.active?.wallClockCapMs ?? cfg.wallClockCapMs,
      getStopping: () => this.stopping,
      appendSystem: (m, s) => this.appendSystem(m, s),
      onCapReached: () => {
        void this.stop();
      },
      getRunId: () => this.active?.runId,
      getBrainService: () => this.opts.getBrainService?.() ?? null,
    });
  }

  protected stopDiscussionWallClock(): void {
    this.wallClockWatchdogStop?.();
    this.wallClockWatchdogStop = undefined;
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

  protected makeAgentEntry(agent: Agent, text: string, summary?: TranscriptEntrySummary): TranscriptEntry {
    return {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text,
      ...(summary ? { summary } : {}),
      ts: Date.now(),
    };
  }

  protected pushEntry(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  protected markAgentReady(agent: Agent): void {
    this.opts.manager.markStatus(agent.id, "ready");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      sessionId: agent.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
  }

  protected markAgentThinking(agent: Agent): void {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      sessionId: agent.sessionId,
      status: "thinking",
      lastMessageAt: Date.now(),
    });
  }

  protected markAgentFailed(agent: Agent, error: string): void {
    this.opts.manager.markStatus(agent.id, "failed", { error });
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      sessionId: agent.sessionId,
      status: "failed",
      error,
    });
  }

  isRunning(): boolean {
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "system",
      text,
      ts: Date.now(),
      summary,
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  appendSystemMessage(text: string, summary?: TranscriptEntrySummary): void {
    this.appendSystem(text, summary);
  }

  reconfig(changes: import("./runReconfig.js").RunReconfigChanges): void {
    this.onReconfig(changes);
  }

  /** Override when a preset must react to limit changes (e.g. restart cap watchdog). */
  protected onReconfig(_changes: import("./runReconfig.js").RunReconfigChanges): void {}

  setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
  }

  protected emitAgentState(s: AgentState): void {
    this.opts.manager.recordAgentState(s);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopDiscussionWallClock();
    this.setPhase("stopping");
    const killResult = await this.opts.manager.killAll();
    this.appendSystem(formatPortReleaseLine(killResult));
    this.setPhase("stopped");
  }

  /**
   * Reset common state fields at the start of a new run.
   * Subclasses should call this and then reset their own extra fields.
   */
  /** Porcelain snapshot at run start — scopes per-run filesChanged in summary. */
  protected gitPorcelainAtRunStart = "";

  protected resetState(cfg: RunConfig): void {
    this.stopDiscussionWallClock();
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.earlyStopDetail = undefined;
    this.gitPorcelainAtRunStart = "";
    this.tokenBaselineForStatus = snapshotLifetimeTokens();
    this.stats.reset();
    this.pendingToolTraceByAgent.clear();
  }

  /** Write the run summary to disk. Guards against double-write.
   *  Subclasses no longer need their own writeSummary — this handles it. */
  protected async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
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
      gitPorcelainAtRunStart: this.gitPorcelainAtRunStart,
      controlAdvice: this.getControlAdviceHistory(),
      appendSystem: (text, summary) => this.appendSystem(text, summary),
    });
  }

  /** Run post-round critique if enabled. Subclasses call this after each round. */
  protected async maybePostRoundCritique(
    cfg: RunConfig,
    presetName: string,
  ): Promise<void> {
    if (!cfg.postRoundCritique) return;
    if (this.stopping) return;
    await maybeRunPostRoundCritique({
      agents: this.opts.manager.list(),
      round: this.round,
      totalRounds: cfg.rounds,
      transcript: this.transcript,
      userDirective: cfg.userDirective ?? "",
      enabled: cfg.postRoundCritique ?? false,
      runDiscussionAgent: (agent, prompt, opts) => this.runDiscussionAgent(agent, prompt, opts),
      stats: this.stats,
      appendSystem: (text) => this.appendSystem(text),
      presetName,
      stopping: this.stopping,
    });
  }

  /** Clone + spawn — extracted to discussionInitClone.ts. */
  protected async initCloneAndSpawn(
    cfg: RunConfig,
    spawnOpts: CloneSpawnOpts,
  ): Promise<CloneSpawnResult> {
    return initCloneAndSpawnExtracted(
      {
        repos: this.opts.repos,
        manager: this.opts.manager,
        emit: (e) => this.opts.emit(e),
        setPhase: (p) => this.setPhase(p),
        appendSystem: (t, s) => this.appendSystem(t, s),
      },
      cfg,
      spawnOpts,
    );
  }

  /** Core agent pipeline — extracted to discussionRunAgent.ts. */
  protected async runDiscussionAgent(
    agent: Agent,
    prompt: string,
    opts: RunAgentOpts,
  ): Promise<string> {
    return runDiscussionAgentCore(
      {
        manager: this.opts.manager,
        emit: (e) => this.opts.emit(e),
        logDiag: this.opts.logDiag,
        transcript: this.transcript,
        phase: this.phase,
        round: this.round,
        active: this.active,
        pendingToolTraceByAgent: this.pendingToolTraceByAgent,
        getStopping: () => this.stopping,
        appendSystem: (t, s) => this.appendSystem(t, s),
        emitAgentState: (s) => this.emitAgentState(s),
        buildDiscussionToolCoachHook: (a) => this.buildDiscussionToolCoachHook(a),
      },
      agent,
      prompt,
      opts,
    );
  }

  /** Subclass must return its preset name (e.g. "Council", "Round-robin"). */
  protected abstract getPresetName(): string;

  private discussionLoopHost() {
    return {
      manager: this.opts.manager,
      emit: (e: import("../types.js").SwarmEvent) => this.opts.emit(e),
      getStopping: () => this.stopping,
      getEarlyStopDetail: () => this.earlyStopDetail,
      setEarlyStopDetail: (d: string | undefined) => { this.earlyStopDetail = d; },
      getRound: () => this.round,
      setRound: (r: number) => { this.round = r; },
      getPhase: () => this.phase,
      setPhase: (p: import("../types.js").SwarmPhase) => this.setPhase(p),
      appendSystem: (text: string, summary?: import("../types.js").TranscriptEntrySummary) =>
        this.appendSystem(text, summary),
      writeSummary: (cfg: RunConfig, crashMessage?: string) => this.writeSummary(cfg, crashMessage),
      getRunId: () => this.active?.runId,
      getBrainService: () => this.opts.getBrainService?.() ?? null,
    };
  }

  /** Shared discussion loop skeleton — extracted to discussionLoop.ts. */
  protected async runDiscussionLoop(
    cfg: RunConfig,
    presetName: string,
    runRounds: (cfg: RunConfig) => Promise<void>,
    closeOutHooks?: DiscussionLoopCloseOutHooks,
  ): Promise<void> {
    // Stamp discuss start for wall-clock if not already set by subclass.
    if (this.startedAt === undefined) this.startedAt = Date.now();
    this.startDiscussionWallClockIfConfigured(cfg);
    try {
      await runDiscussionLoopExtracted(
        this.discussionLoopHost(),
        cfg,
        presetName,
        runRounds,
        closeOutHooks,
      );
    } finally {
      this.stopDiscussionWallClock();
    }
  }

  /** Budget guard + round-state update — extracted to discussionLoop.ts. */
  protected checkRoundBudget(
    cfg: RunConfig,
    presetName: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ): boolean {
    return checkRoundBudgetExtracted(
      this.discussionLoopHost(),
      cfg,
      presetName,
      r,
      tokenBaseline,
    );
  }
}