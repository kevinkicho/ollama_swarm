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
import { buildAgentsReadySummary } from "./agentsReadySummary.js";
import { formatChatReceipt } from "./chatReceipt.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { formatPortReleaseLine } from "./runSummary.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { buildCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";

export interface CloneSpawnResult {
  destPath: string;
  ready: Agent[];
}

export interface CloneSpawnOpts {
  /** Preset name for the agentsReady summary */
  preset: string;
  /** If provided, override the minimum agent count check (default: 1) */
  minAgents?: number;
  /** Role label resolver for each agent */
  roleResolver: (agent: Agent) => string;
  /** Extra line appended to the "N agents ready" message (preset-specific context) */
  extraReadyMessage?: string;
}

export interface RunAgentOpts {
  /** Runner name for diagnostic logging (e.g. "council", "debate-judge") */
  runnerName: string;
  /** Agent name for the prompt call: "swarm-read" (discussion) or "swarm" (write-capable) */
  agentName?: "swarm" | "swarm-read";
  /** Custom summary for the transcript entry. Can be a static value or a
   *  function that receives the final stripped text and returns a summary. */
  enrichSummary?: TranscriptEntrySummary | ((text: string) => TranscriptEntrySummary | undefined);
  /** Optional model override for this specific prompt call (e.g. dynamic routing) */
  modelOverride?: string;
  /** Called after the transcript entry is pushed (for multiWriter collection, etc.) */
  onEntryPushed?: (entry: TranscriptEntry, strippedText: string) => void;
  /** Stats instance to record timing/retry/junk metrics. If provided,
   *  onTiming/onRetry/recordTokens are wired automatically. */
  stats: {
    countTurn(agentId: string): void;
    onTiming(agentId: string, success: boolean, elapsedMs: number): void;
    onRetry(agentId: string): void;
    recordJunkPostRetry(agentId: string, isJunk: boolean): number;
    recordTokens(agentId: string, promptTokens: number, responseTokens: number): void;
  };
}

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

  constructor(protected readonly opts: RunnerOpts) {}

  // --- Shared methods (identical across all 8 discussion runners) ---

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

  setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
  }

  protected emitAgentState(s: AgentState): void {
    this.opts.manager.recordAgentState(s);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    const killResult = await this.opts.manager.killAll();
    this.appendSystem(formatPortReleaseLine(killResult));
    this.setPhase("stopped");
  }

  /**
   * Reset common state fields at the start of a new run.
   * Subclasses should call this and then reset their own extra fields.
   */
  protected resetState(cfg: RunConfig): void {
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.earlyStopDetail = undefined;
    this.stats.reset();
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

  /**
   * Clone the repo, exclude artifacts, spawn agents, validate + register.
   * Returns `{ destPath, ready }` for the subclass to continue setup.
   *
   * Replaces ~35 duplicated lines per runner.
   */
  protected async initCloneAndSpawn(
    cfg: RunConfig,
    spawnOpts: CloneSpawnOpts,
  ): Promise<CloneSpawnResult> {
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

    const minAgents = spawnOpts.minAgents ?? 1;
    if (ready.length < minAgents) {
      if (minAgents === 1) {
        throw new Error("No agents started successfully");
      }
      throw new Error(
        `${spawnOpts.preset} requires at least ${minAgents} agents, but only ${ready.length} started.`,
      );
    }

    const portList = ready.map((a) => a.port).join(", ");
    const extra = spawnOpts.extraReadyMessage ? ` ${spawnOpts.extraReadyMessage}` : "";
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${portList}.${extra}`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: spawnOpts.preset,
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: spawnOpts.roleResolver,
      }),
    );

    return { destPath, ready };
  }

  /**
   * Core agent-prompt-execute-record pipeline shared by all discussion runners.
   *
   * Handles the full lifecycle of prompting an agent and recording its response:
   *   1. markStatus("thinking") + emitAgentState
   *   2. SSE-aware watchdog setup
   *   3. promptWithFailoverAuto with onTokens/onTiming/onRetry wiring
   *   4. extractText → junk retry → trackPostRetryJunk → stripAgentText
   *   5. TranscriptEntry construction + push + emit
   *   6. markStatus("ready"/"failed") + emitAgentState
   *   7. watchdog.cancel() in finally
   *
   * Returns the extracted text string on success, or "" on error.
   * MoA's simpler runOne also delegates here.
   */
  protected async runDiscussionAgent(
    agent: Agent,
    prompt: string,
    opts: RunAgentOpts,
  ): Promise<string> {
    const agentName = opts.agentName ?? "swarm-read";
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    opts.stats.countTurn(agent.id);

    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: async () => {},
    });

    try {
      const res = await promptWithFailoverAuto(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => opts.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        agentName,
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: describeSdkError,
        ...(opts.modelOverride && opts.modelOverride !== agent.model
          ? { modelOverride: opts.modelOverride }
          : {}),
        onTiming: ({ attempt, elapsedMs, success }) => {
          opts.stats.onTiming(agent.id, success, elapsedMs);
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
          opts.stats.onRetry(agent.id);
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
        runner: opts.runnerName,
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(agent, prompt, agentName, diagCtx);
        if (retryText !== null) text = retryText;
      }
      trackPostRetryJunk(text, {
        agentId: agent.id,
        recordJunkPostRetry: (id, j) => opts.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      const stripped = stripAgentText(text);

      // Compute summary: either from enrichSummary callback, static value, or undefined
      const summary: TranscriptEntrySummary | undefined =
        typeof opts.enrichSummary === "function"
          ? opts.enrichSummary(stripped.finalText)
          : opts.enrichSummary;

      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        ...(summary ? { summary } : {}),
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };

      // Hook for multiWriter collection or other post-entry logic
      opts.onEntryPushed?.(entry, stripped.finalText);

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

      // Direction 6: checkpoint after each agent turn (when configured)
      if (this.active?.runId && this.active?.checkpointing) {
        const ckpt = buildCheckpoint(
          this.active.runId,
          this.phase,
          this.round,
          agent.index,
          this.transcript,
          this.opts.manager.toStates(),
          this.active,
        );
        writeCheckpoint(this.active.localPath, ckpt).catch(() => {});
      }

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