import { randomUUID } from "node:crypto";
import { createOutcomeEmitter, type OutcomeScoredEvent } from "./outcomeTypes.js";
import type { Agent } from "../services/AgentManager.js";

import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { selectModelForRole } from "./dynamicModelRoute.js";
import { defaultRoleForIndex } from "@ollama-swarm/shared/topology";
import { userEntryVisibleTo } from "./chatReceipt.js";
import { writeMapReduceDeliverableImpl } from "./mapReduceDeliverableWriter.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

// runEndReflection moved into runFinallyHooks (Phase D).

import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import { describeSdkError } from "./sdkError.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import { buildMapReduceSeedMessage } from "./mapReduceSeed.js";
import { runStreamingMapReduce as runStreamingMapReduceExtracted } from "./mapReduceStreaming.js";
import { runMapReduceLoopBody } from "./mapReduceLoopBody.js";

import {
  parseMapperComplete,
  buildMapperPrompt,
  buildReducerPrompt,
} from "./mapReducePromptHelpers.js";

// Map-reduce over the repo.
// Agent 1 = REDUCER (silent during the map phase, then synthesizes).
// Agents 2..N = MAPPERS (each gets a slice of top-level repo entries
// and inspects ONLY that slice — no peer reports, no transcript
// beyond the seed).
//
// The value over orchestrator-worker is that the split is mechanical
// (pre-determined by the runner, not decided by an LLM planner) and
// therefore not subject to the planner's laziness. The cost is less
// targeted coverage — mappers don't get to pick what to study.
//
// `rounds` = how many map-reduce cycles. Cycle 1 is always broad
// coverage; cycle 2+ lets the reducer re-issue mappers to fill
// specific gaps surfaced by the prior synthesis.
// Discussion-only, no file edits.
export class MapReduceRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Map-Reduce"; }

  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.

  // Phase 2d: mapper slice assignments, keyed by agentId. Empty map
  // pre-run or if slicing hasn't happened yet.
  private mapperSlices: Record<string, string[]> = {};
  // T192 (2026-05-04): per-mapper-index reframing instructions extracted
  // from the previous reducer turn's RE-TASK lines. Cleared at start
  // of each cycle, populated after reducer turn, threaded into next
  // cycle's mapper prompts. Keyed by mapper agentIndex (NOT id).
  private nextCycleReframings: Map<number, string> = new Map();
  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;
  // Phase B (Task #97): set of mapper agent IDs that have flagged
  // their slice complete. When this matches the live mapper set, the
  // run can stop early — no point reducing the same content again.
  private mappersComplete = new Set<string>();

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  status(): SwarmStatus {
    return {
      ...super.status(),
      // Phase 2d: mapper slice assignments for CoveragePanel catch-up.
      mapperSlices: { ...this.mapperSlices },
    };
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.mappersComplete = new Set();

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "map-reduce",
      minAgents: 3,
      roleResolver: (a) => (a.index === 1 ? "Reducer" : "Mapper"),
      extraReadyMessage: ` Agent 1 is the REDUCER; agents 2..${cfg.agentCount} are MAPPERS.`,
    });
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      this.multiWriter = new MultiWriterState({
        writeMode: cfg.writeMode,
        conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["map-reduce"],
        clonePath: destPath,
      });
      this.appendSystem(
        `Multi-writer mode enabled — mappers will propose hunks during rounds, reconciled via ${cfg.conflictPolicy ?? "merge"} policy.`,
      );
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    await this.runTrackedLoop(() => this.loop(cfg, destPath));
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const { text, summary } = buildMapReduceSeedMessage({ clonePath, cfg, tree });
    this.appendSystem(text, summary);
  }

  private async loop(cfg: RunConfig, clonePath: string): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await runMapReduceLoopBody(
        {
          manager: this.opts.manager,
          repos: this.opts.repos,
          emit: (e) => this.opts.emit(e),
          transcript: this.transcript,
          mappersComplete: this.mappersComplete,
          stats: this.stats,
          getStopping: () => this.stopping,
          getNextCycleReframings: () => this.nextCycleReframings,
          setNextCycleReframings: (m) => { this.nextCycleReframings = m; },
          setMapperSlices: (s) => { this.mapperSlices = s; },
          setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
          appendSystem: (t, s) => this.appendSystem(t, s as any),
          checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
          runDiscussionAgent: (a, p, o) => this.runDiscussionAgent(a, p, o as any),
          runStreamingMapReduce: (input) => this.runStreamingMapReduce(input),
          runMapperTurn: (a, r, tr, s, snap, d, ref) =>
            this.runMapperTurn(a, r, tr, s, snap, d, ref),
          runReducerTurn: (a, r, tr, fin, d) => this.runReducerTurn(a, r, tr, fin, d),
          getRunId: () => this.active?.runId ?? cfg.runId,
          getBrainService: () => this.opts.getBrainService?.() ?? null,
        },
        cfg,
        clonePath,
      );
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-02 (deliverables initiative): structured markdown.
      if (!this.stopping && cfg.runId) await this.writeMapReduceDeliverable(cfg);
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
            `Map-reduce preset · 1 reducer + ${cfg.agentCount - 1} mappers · ran ${s.round}/${cfg.rounds} cycles${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

  private async writeMapReduceDeliverable(cfg: RunConfig): Promise<void> {
    await writeMapReduceDeliverableImpl({
      cfg,
      transcript: this.transcript,
      round: this.round,
      earlyStopDetail: this.earlyStopDetail,
      manager: this.opts.manager,
      repos: this.opts.repos,
      emit: this.opts.emit,
      appendSystem: (text) => this.appendSystem(text),
      multiWriter: this.multiWriter,
      stats: this.stats,
      stopping: this.stopping,
      summaryWritten: this.summaryWritten,
      startedAt: this.startedAt,
    });
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  // T199 (2026-05-04): real streaming reducer. Replaces T198a's
  // half-batch synchronous split with an event-driven scheduler that
  // fires intermediate reducer turns at fractional thresholds (1/3,
  // 2/3 of mapper completions). The final reducer always fires after
  // all mappers complete.
  //
  // Implementation: launch all mappers as promises, attach completion
  // counters via .then(), use a tracking promise that resolves at
  // each threshold to gate the intermediate reducer turns. Because
  // we use Promise.race + a "next-threshold" sentinel, mappers stay
  // genuinely parallel (not blocked by reducer turns); the reducer
  // turns interleave WITHOUT pausing remaining mappers.
  //
  // Compared to the T198a thin-cut: produces 3 reducer turns per
  // cycle (vs T198a's 2) AND the timing is event-driven not
  // boundary-synchronous, so a single slow mapper doesn't bottleneck
  // the early reduce.
  private async runStreamingMapReduce(input: {
    mappers: Agent[];
    reducer: Agent;
    slices: string[][];
    reframingsThisCycle: Map<number, string>;
    seedSnapshot: readonly TranscriptEntry[];
    round: number;
    totalRounds: number;
    userDirective?: string;
  }): Promise<void> {
    await runStreamingMapReduceExtracted(
      {
        getStopping: () => this.stopping,
        appendSystem: (t) => this.appendSystem(t),
        runMapperTurn: (a, r, tr, s, snap, d, ref) =>
          this.runMapperTurn(a, r, tr, s, snap, d, ref),
        runReducerTurn: (a, r, tr, fin, d) => this.runReducerTurn(a, r, tr, fin, d),
      },
      input,
    );
  }

  private async runMapperTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    slice: readonly string[],
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    reframing?: string,
  ): Promise<void> {
    // 2026-05-02 (chat lever #3): per-agent @mention filter on the seed
    // snapshot so user entries targeted elsewhere don't leak into this
    // mapper's prompt.
    const visibleSeed = seedSnapshot.filter((e) => userEntryVisibleTo(e, agent.id));
    const prompt = buildMapperPrompt(agent.index, round, totalRounds, slice, visibleSeed, userDirective, reframing);
    // Phase B (Task #97): scan the mapper's last few lines for a
    // COMPLETE: true|false declaration. Tracking is sticky — once a
    // mapper says complete, it stays complete; later cycles can't
    // un-set it (they wouldn't be running if the loop broke).
    await this.runAgent(agent, prompt, (text) => {
      if (parseMapperComplete(text)) {
        this.mappersComplete.add(agent.id);
      }
      return undefined;
    });
  }

  private async runReducerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    isFinalOverride?: boolean,
    userDirective?: string,
  ): Promise<void> {
    const prompt = buildReducerPrompt(round, totalRounds, [...this.transcript], userDirective);
    // Task #82: tag the FINAL cycle's reducer output as the run's
    // synthesis so the modal renders distinctively. Earlier cycles
    // are intermediate reductions; only the last one is the "answer".
    // Task #97: allow explicit override so the early-stop reducer
    // pass also gets the synthesis tag (its output IS the answer).
    const isFinal = isFinalOverride ?? round === totalRounds;
    // Task #108: defensive guard — if the reducer's text looks like
    // junk, do NOT apply the synthesis tag (the run history modal
    // would otherwise render `:` or similar as the canonical answer).
    await this.runAgent(
      agent,
      prompt,
      isFinal
        ? (text) => {
            if (looksLikeJunk(text)) {
              this.appendSystem(
                `[${agent.id}] map-reduce synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
              );
              return undefined;
            }
            return { kind: "mapreduce_synthesis", cycle: round };
          }
        : undefined,
    );
  }

  private async runAgent(
    agent: Agent,
    prompt: string,
    enrichSummary?: (text: string) => TranscriptEntrySummary | undefined,
  ): Promise<void> {
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
      // set, pick reducer/mapper-tier model. Reducer (agent 1) uses
      // planner-tier model; mappers (agents 2..N) use worker-tier.
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
        // Builder tools when multi-writer may emit file changes; else read-only.
        agentName: this.multiWriter?.isActive()
          ? (await import("./discussionToolProfile.js")).discussionBuilderProfile(this.active)
          : "swarm-read",
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
        runner: "map-reduce",
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
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const stripped = finalizeAgentOutput(text, { role: "general" });
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        // Task #82: optional enriched summary from the caller.
        summary: enrichSummary?.(stripped.finalText),
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
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
    } finally {
      watchdog.cancel();
    }
  }

}
