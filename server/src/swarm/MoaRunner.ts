// #88 (2026-05-01): Mixture of Agents (MoA) preset.
//
// Together AI's research pattern (Wang et al.). Two layers per round:
//   Layer 1 (proposers): N agents each respond to the same seed in
//     parallel. Each proposer's prompt is peer-hidden — no agent sees
//     any other agent's draft. The independence is the whole point.
//   Layer 2 (aggregator): one agent synthesizes all N proposals into a
//     single coherent answer, optionally citing where they agreed /
//     disagreed.
//
// MoA reproducibly beats single-large-model on reasoning benchmarks
// using only small open-weights models — exactly this project's value
// prop ("N small models > 1 big model"). Discussion-only; no file
// edits.
//
// Differs from CouncilRunner: council does multi-round REVISION (peer-
// hidden round 1 → peer-visible round 2..N where each agent sees and
// revises its own draft). MoA does explicit AGGREGATION (peer-hidden
// proposers → dedicated aggregator that synthesizes). Both share the
// "round 1 = peer-hidden parallel drafts" idea; MoA's edge is the
// aggregator's framing of "find what these N agree on, drop what only
// one said."
//
// Multi-round: round R's aggregator output becomes round R+1's seed
// addition, so each round's proposers see the prior synthesis. Stops
// at `rounds` iterations.

import { createOutcomeEmitter, type OutcomeScoredEvent } from "./outcomeTypes.js";
import type { Agent } from "../services/AgentManager.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import type { DerivedRubric } from "./rubricPrePass.js";
import type { MultiWriterState } from "./multiWriterState.js";
import { writeMoaDeliverable as writeMoaDeliverableImpl } from "./moaDeliverableWriter.js";
import {
  runAggregationTree as runAggregationTreeImpl,
  runAggregatorSelfCritique as runAggregatorSelfCritiqueImpl,
} from "./moaAggregation.js";
import { moaRunOne } from "./moaRunOne.js";
import { runMoaLoopBody } from "./moaLoopBody.js";

export class MoaRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "MoA"; }

  // 2026-05-01: gates writeSummary so it fires exactly once per run even
  // if the loop exits via multiple paths (early return + finally).
  // Captured by writeSummary; undefined when run ended by exception.
  private actualRoundsCompleted = 0;
  // 2026-05-02 (quality lever #2): rubric derived at run-start; used
  // by writeMoaDeliverable for the Success-criteria section + critic
  // pass.
  private derivedRubric: DerivedRubric | null = null;
  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.actualRoundsCompleted = 0;

    void this.loop(cfg).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`MoA crashed: ${msg}`);
      this.setPhase("failed");
    });
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await this.loopBody(cfg);
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-01: every other discussion runner writes summary.json at
      // run termination via try/finally; MoA was missing this entirely,
      // which made every MoA attempt's summary.json read the previous
      // run's data (eval harness pulled stale council seed3 data for
      // every moa attempt during the first sweep 2 run). Mirror the
      // CouncilRunner pattern to fix.
      // 2026-05-02 (deliverables initiative + quality levers): structured
      // markdown + rubric + critic + next-actions before writeSummary so
      // the file lands even when the summary path errors. Best-effort.
      if (!this.stopping && cfg.runId && this.actualRoundsCompleted > 0) {
        await this.writeMoaDeliverable(cfg);
      }
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // MoA opts out of: reflection (no preset-specific lesson template
      // wired up — pickReflectionAgent returns null) AND uses a custom
      // shouldSetCompleted guard so a phase=failed inline-set inside
      // the loop body isn't overwritten by setPhase("completed").
      this.stopDiscussionWallClock();
      await runDiscussionCloseOut({
        cfg,
        crashMessage,
        stopping: this.stopping,
        round: this.round,
        currentPhase: this.phase,
        manager: this.opts.manager,
        appendSystem: (text) => this.appendSystem(text),
        setPhase: (p) => this.setPhase(p),
        writeSummary: () => this.writeSummary(cfg, crashMessage),
        hooks: {
          pickReflectionAgent: () => null,
          shouldSetCompleted: (current) => current !== "failed",
        },
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

  private async loopBody(cfg: RunConfig): Promise<void> {
    await runMoaLoopBody(
      {
        repos: this.opts.repos,
        manager: this.opts.manager,
        emit: (e) => this.opts.emit(e),
        ollamaBaseUrl: this.opts.ollamaBaseUrl,
        transcript: this.transcript,
        getStopping: () => this.stopping,
        getDerivedRubric: () => this.derivedRubric,
        setDerivedRubric: (r) => { this.derivedRubric = r; },
        setStartedAt: (ts) => {
          this.startedAt = ts;
          this.startDiscussionWallClockIfConfigured(cfg);
        },
        getMultiWriter: () => this.multiWriter,
        setMultiWriter: (mw) => { this.multiWriter = mw; },
        setRound: (r) => { this.round = r; },
        getActualRoundsCompleted: () => this.actualRoundsCompleted,
        setActualRoundsCompleted: (n) => { this.actualRoundsCompleted = n; },
        setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
        appendSystem: (t, s) => this.appendSystem(t, s as any),
        setPhase: (p) => this.setPhase(p),
        runOne: (agent, prompt, label) => this.runOne(agent, prompt, label),
        runAggregatorSelfCritique: (agg, synthesis, proposals) =>
          this.runAggregatorSelfCritique(agg, synthesis, proposals),
        runAggregationTree: (input) => this.runAggregationTree(input),
        getRunId: () => this.active?.runId ?? cfg.runId,
        getBrainService: () => this.opts.getBrainService?.() ?? null,
      },
      cfg,
    );
  }

  // 2026-05-01: mirror of CouncilRunner.writeSummary. MoA was missing
  // this entirely; eval harness consumes <clonePath>/summary.json so the
  // missing write meant every MoA attempt re-read the previous run's
  // summary. Pure end-of-run snapshot; no agent stats yet (MoA doesn't
  // wire AgentStatsCollector — future enhancement).
  // 2026-05-02 (deliverables initiative + quality levers #1-#3):
  // structured markdown artifact for MoA. Pulled into moaDeliverableWriter;
  // this thin delegator preserves call-site clarity.
  private async writeMoaDeliverable(cfg: RunConfig): Promise<void> {
    await writeMoaDeliverableImpl({
      cfg,
      transcript: this.transcript,
      derivedRubric: this.derivedRubric,
      actualRoundsCompleted: this.actualRoundsCompleted,
      manager: this.opts.manager,
      repos: this.opts.repos,
      emit: this.opts.emit,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
    });
  }

  protected async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
    // 2026-05-03 (Phase C): writeSummary body extracted to shared helper.
    // MoA opts out of: banner emission (no per-agent stats to render),
    // files=N suffix in log line, and overrides rounds with
    // `actualRoundsCompleted`.
    // 2026-05-03 (post-Phase-D): earlyStopDetail now wired up for the
    // budget/quota guard added to the MoA loop.
    await discussionWriteSummary({
      cfg,
      crashMessage,
      stopping: this.stopping,
      startedAt: this.startedAt,
      earlyStopDetail: this.earlyStopDetail,
      rounds: this.actualRoundsCompleted || cfg.rounds,
      agentCount: cfg.agentCount,
      // MoA doesn't track AgentStatsCollector yet — empty array is the
      // honest "no per-agent metrics" placeholder. The runId + transcript
      // give the eval harness everything it needs to score uniqueness.
      agents: [],
      transcript: this.transcript,
      topology: cfg.topology,
      repos: this.opts.repos,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
      emitBanner: false,
      includeFilesInLogLine: false,
    });
  }

  /** One prompt → cleaned text. Records the agent message in the
   *  transcript. Throws on transport errors so the caller can decide
   *  whether to abort the whole round.
   *
   *  2026-05-01 bug fix: emit agent_state events around the prompt so
   *  the UI sidebar shows current status. Pre-fix: MoaRunner had zero
   *  emitAgentState calls (BlackboardRunner has 5+); the sidebar
   *  showed agents at their initial spawn state ("ready") forever
   *  while they were actually thinking. */
  // T199 (2026-05-04): N-level MoA aggregation tree. Extracted to
  // moaAggregation.ts; this thin delegator preserves call-site clarity.
  private async runAggregationTree(input: {
    seed: string;
    initialInputs: ReadonlyArray<{ workerId: string; text: string }>;
    levels: number;
    availableAggregators: readonly Agent[];
  }): Promise<{ text: string; layerSizes: number[] }> {
    return runAggregationTreeImpl({
      ...input,
      manager: this.opts.manager,
      appendSystem: (text) => this.appendSystem(text),
    });
  }

  // 2026-05-02 (matrix row #3 + issue #2 fix): aggregator self-critique
  // with a DIFFERENT-AGENT review. Extracted to moaAggregation.ts; this
  // thin delegator preserves call-site clarity.
  private async runAggregatorSelfCritique(
    agg: Agent,
    synthesis: string,
    proposals: ReadonlyArray<{ workerId: string; text: string }>,
  ): Promise<string> {
    return runAggregatorSelfCritiqueImpl({
      agg,
      synthesis,
      proposals,
      runOne: (agent, prompt, label) => this.runOne(agent, prompt, label),
      appendSystem: (text) => this.appendSystem(text),
      stopping: this.stopping,
    });
  }

  private async runOne(agent: Agent, prompt: string, label: string): Promise<string> {
    return moaRunOne(
      {
        manager: this.opts.manager,
        active: this.active,
        multiWriter: this.multiWriter,
        transcript: this.transcript,
        emit: (e) => this.opts.emit(e),
        appendSystem: (t) => this.appendSystem(t),
        markStatus: (id, s) => this.opts.manager.markStatus(id, s),
        emitAgentStatus: (a, s, ts) => this.emitAgentStatus(a, s, ts),
      },
      agent,
      prompt,
      label,
    );
  }

  /** Mirror of BlackboardRunner.emitAgentState — surfaces per-agent
   *  status flips to the WS so the sidebar's AgentPanel updates live.
   *  Without this the panel shows the spawn-time state forever. */
  private emitAgentStatus(agent: Agent, status: "thinking" | "ready", thinkingSince?: number): void {
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status,
      ...(thinkingSince !== undefined ? { thinkingSince } : {}),
    });
  }
}
