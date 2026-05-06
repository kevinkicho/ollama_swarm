import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";

import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  SwarmStatus,
  SwarmEvent,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { selectModelForRole } from "./dynamicModelRoute.js";
import { defaultRoleForIndex } from "../../../shared/src/topology.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeMapReduceDeliverableImpl } from "./mapReduceDeliverableWriter.js";
// T197 (2026-05-04): smart slicing by import graph (opt-in via cfg.importGraphSlicing).
import { buildImportGraph, clusterByImports } from "./importGraph.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

// runEndReflection moved into runFinallyHooks (Phase D).
import { staggerStart } from "./staggerStart.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import {
  readDirective,
  buildDirectiveBlock,

} from "./directivePromptHelpers.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";

import {
  SKIP_ENTRIES,
  parseMapperComplete,
  sliceRoundRobin,
  sliceSizeBalanced,
  buildMapperPrompt,
  buildReducerPrompt,
  parseReducerReTaskLines,
  MAPPER_LENSES,
  lensForMapper,
} from "./mapReducePromptHelpers.js";
import type { MapperLens } from "./mapReducePromptHelpers.js";
import { runCouncilMapperSlice, type CouncilMapperResult } from "./mapReduceCouncilMapper.js";

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
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
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
    this.stats.reset();
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
    void this.loop(cfg, destPath);
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    // 2026-05-02 (map-reduce improvement #1): user directive turns the
    // preset from "tell me everything about this repo in parallel" into
    // "find me everything in this repo that bears on this question, in
    // parallel". Mappers + reducer both see the directive; mappers
    // explicitly told that "no relevant findings in my slice" is a
    // valid + welcome answer (anti-hallucination valve).
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "The map-reduce sweep should find everything in this repo that bears on the directive above. Mappers: report findings relevant to the directive within YOUR slice; if your slice has nothing relevant, say so explicitly — that's a valid + welcome answer. Reducer: synthesize across mappers to ANSWER the directive.",
        ],
      }),
      "Pattern: Map-reduce. Agent 1 is the REDUCER; others are MAPPERS.",
      "Each mapper inspects only its assigned slice of the repo (in isolation). The reducer consolidates all mapper reports at the end of each cycle.",
    ];
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig, clonePath: string): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const reducer = agents.find((a) => a.index === 1);
      const mappers = agents.filter((a) => a.index !== 1);
      if (!reducer) throw new Error("reducer agent (index 1) did not spawn");
      if (mappers.length < 2) throw new Error("need at least 2 mappers");

      // T197 (2026-05-04): smart slicing by import graph. When opt-in
      // via cfg.importGraphSlicing, build a TS/JS import graph + cluster
      // files by connected component so each mapper sees a coherent
      // subset of the codebase (a→b→c stays together). Falls back to
      // round-robin slicing on graph-build failure or when the
      // resulting clusters are too lopsided (one giant SCC > 70% of
      // files).
      let slices: string[][];
      // T-Item-MapPart (2026-05-04): "size-balanced" partition mode.
      // Determined by cfg.mapReducePartition; back-compat with the
      // legacy cfg.importGraphSlicing flag (when set, treat as
      // mapReducePartition="import-graph"). When the resolved mode
      // is "size-balanced", weight top-level entries by their
      // recursive file count and use sliceSizeBalanced.
      const partitionMode: "round-robin" | "size-balanced" | "import-graph" =
        cfg.mapReducePartition ??
        (cfg.importGraphSlicing ? "import-graph" : "round-robin");
      let slicingMode: "round-robin" | "size-balanced" | "import-graph" = "round-robin";
      if (partitionMode === "import-graph") {
        try {
          const allFiles = await this.opts.repos.listRepoFiles(clonePath, {
            maxFiles: 500,
          });
          const tsJsFiles = allFiles.filter((f) =>
            /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f),
          );
          if (tsJsFiles.length >= mappers.length * 2) {
            const graph = await buildImportGraph(clonePath, tsJsFiles);
            const candidate = clusterByImports(tsJsFiles, graph, mappers.length);
            // Reject if any single cluster holds > 70% of files
            // (one giant SCC) — fall back to round-robin.
            const maxSize = Math.max(...candidate.map((c) => c.length));
            if (maxSize > tsJsFiles.length * 0.7) {
              this.appendSystem(
                `[T197 import-graph slicing] one cluster holds ${maxSize}/${tsJsFiles.length} files (> 70%) — falling back to round-robin slicing.`,
              );
            } else {
              slices = candidate;
              slicingMode = "import-graph";
            }
          } else {
            this.appendSystem(
              `[T197 import-graph slicing] only ${tsJsFiles.length} TS/JS files (< 2× mappers) — falling back to round-robin slicing.`,
            );
          }
        } catch (err) {
          this.appendSystem(
            `[T197 import-graph slicing] failed (${err instanceof Error ? err.message : String(err)}) — falling back to round-robin.`,
          );
        }
      }
      const topLevel = await this.opts.repos.listTopLevel(clonePath);
      const slicingSource = topLevel.filter((e) => !SKIP_ENTRIES.has(e));
      // T-Item-MapPart (2026-05-04): size-balanced fork. Weight each
      // top-level entry by listing its recursive file count via
      // listRepoFiles + counting matches. Best-effort: a listRepoFiles
      // failure for one entry treats it as weight=1 (it still gets
      // sliced; just doesn't dominate). Falls through to round-robin
      // when no entries (single-file repo).
      if (
        slices! === undefined &&
        partitionMode === "size-balanced" &&
        slicingSource.length > 0
      ) {
        try {
          const allFiles = await this.opts.repos.listRepoFiles(clonePath, {
            maxFiles: 5000,
          });
          // Count files per top-level entry. POSIX-style prefix match.
          const weights = slicingSource.map((entry) => {
            const prefix = entry.endsWith("/") ? entry : `${entry}/`;
            // Files DIRECTLY at top level have entry as their FULL path
            const exact = allFiles.includes(entry) ? 1 : 0;
            // Files UNDER this entry have entry/ prefix
            const sub = allFiles.filter((f) =>
              f.startsWith(prefix),
            ).length;
            return Math.max(1, exact + sub);
          });
          slices = sliceSizeBalanced(
            slicingSource.map((item, i) => ({ item, weight: weights[i] })),
            mappers.length,
          );
          slicingMode = "size-balanced";
          this.appendSystem(
            `[T-Item-MapPart size-balanced] weights=${weights.join(",")}; LPT-greedy assignment.`,
          );
        } catch (err) {
          this.appendSystem(
            `[T-Item-MapPart size-balanced] failed (${err instanceof Error ? err.message : String(err)}) — falling back to round-robin.`,
          );
        }
      }
      // eslint-disable-next-line prefer-const
      slices = slices! ?? sliceRoundRobin(slicingSource, mappers.length);
      const slicingDesc =
        slicingMode === "import-graph"
          ? "import-graph clusters"
          : slicingMode === "size-balanced"
            ? `size-balanced (LPT) over ${slicingSource.length} top-level entries`
            : `round-robin over ${slicingSource.length} top-level entries`;
      this.appendSystem(
        `Repo slicing: ${slicingDesc} across ${mappers.length} mappers.`,
      );
      // Phase 2d: stash + emit slice assignments so CoveragePanel can
      // render the tree view. Keyed by agentId for consistency with
      // other per-agent maps (latency etc.).
      const slicesById: Record<string, string[]> = {};
      for (let i = 0; i < mappers.length; i++) {
        slicesById[mappers[i].id] = slices[i] ?? [];
      }
      this.mapperSlices = slicesById;
      this.opts.emit({ type: "mapper_slices", slices: slicesById });

      // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
      const tokenBaseline = snapshotLifetimeTokens();
      const deadLoopGuard = new OutputEmptyDeadLoopGuard({
        roleLabel: "mappers",
        unit: "cycle",
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

        this.appendSystem(`Cycle ${r}/${cfg.rounds}: MAP phase — mappers inspecting slices in parallel.`);

        // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED for
        // consistency with council/OW after v4 battle test showed it
        // hurt them. Map-reduce was the only one of the three where v4
        // pre-batch warmup actually improved coverage (1/4 -> 2/4
        // mappers), but the gain was small (40% -> 60%) vs the
        // regressions elsewhere. Keep the simpler shape — serial
        // spawn-warmup only — and revisit if MR coverage proves a
        // ceiling separately worth a dedicated fix.

        // MAP — mappers fire in parallel. Each sees only its assigned slice
        // + the seed. No transcript, no peer reports.
        // Task #53: stagger the N parallel mapper prompts to avoid the
        // Pattern 3 cold-start queue race confirmed in 2026-04-24 logs.
        const seedSnapshot = this.transcript.filter((e) => e.role === "system");
        const transcriptLenBefore = this.transcript.length;
        // T192 (2026-05-04): pull this cycle's reframings (set by the
        // PREVIOUS cycle's reducer turn). Empty on cycle 1 always.
        // Cleared after we read them so cycle r+2 doesn't get stale
        // framings from cycle r.
        const reframingsThisCycle = this.nextCycleReframings;
        this.nextCycleReframings = new Map();
        // T199 (2026-05-04): real streaming reducer. Replaces the
        // half-batch synchronous split (T198a thin-cut) with a true
        // event-driven reducer that fires AT EACH MAPPER COMPLETION
        // boundary based on a fractional schedule. Uses Promise.race
        // to detect completions, counts toward thresholds (1/3, 2/3),
        // fires intermediate reducer turns at each boundary. Cuts
        // wall-clock when one mapper is slow + gives the reducer
        // continuously-refreshing state instead of batched bursts.
        if (cfg.councilMappers) {
          const councilResults: CouncilMapperResult[] = [];
          for (let i = 0; i < mappers.length; i++) {
            if (this.stopping) break;
            const mySlice = slices[i] ?? [];
            // Use 2-3 agents per slice for the council. For simplicity,
            // all mappers share the same reducer agent count. We pick
            // a subset of 2-3 agents for each council.
            const councilSize = Math.min(3, mappers.length);
            const councilAgents: Agent[] = [];
            for (let j = 0; j < councilSize; j++) {
              councilAgents.push(mappers[(i + j) % mappers.length]!);
            }
            const result = await runCouncilMapperSlice({
              agents: councilAgents,
              slice: mySlice,
              seedTranscript: seedSnapshot,
              userDirective: cfg.userDirective,
              runDiscussionAgent: (agent, prompt, opts) =>
                this.runDiscussionAgent(agent, prompt, opts),
              stats: this.stats,
              appendSystem: (text) => this.appendSystem(text),
              presetName: "map-reduce",
              stopping: this.stopping,
              rounds: cfg.councilMapperRounds,
            });
            councilResults.push(result);
            // Record the synthesis as a mapper transcript entry
            if (result.synthesis.length > 0) {
              const entry: TranscriptEntry = {
                id: randomUUID(),
                role: "agent",
                agentId: mappers[i]!.id,
                agentIndex: mappers[i]!.index,
                text: result.synthesis,
                ts: Date.now(),
                summary: { kind: "mapreduce_synthesis", cycle: r },
              };
              this.transcript.push(entry);
              this.opts.emit({ type: "transcript_append", entry });
              this.opts.emit({ type: "agent_streaming_end", agentId: mappers[i]!.id });
            }
          }
        } else if (cfg.streamingReducer && mappers.length >= 3) {
          await this.runStreamingMapReduce({
            mappers,
            reducer,
            slices,
            reframingsThisCycle,
            seedSnapshot,
            round: r,
            totalRounds: cfg.rounds,
            userDirective: cfg.userDirective,
          });
        } else {
          await staggerStart(mappers, (m, i) => {
            const mySlice = slices[i] ?? [];
            const reframing = reframingsThisCycle.get(m.index);
            return this.runMapperTurn(m, r, cfg.rounds, mySlice, seedSnapshot, cfg.userDirective, reframing);
          });
        }
        if (this.stopping) break;
        // Task #146: dead-loop guard. If every mapper produced empty/junk
        // output this cycle, count toward break threshold.
        // 2026-05-03 (Phase B): logic extracted to OutputEmptyDeadLoopGuard.
        const newEntries = this.transcript
          .slice(transcriptLenBefore)
          .filter((e) => e.role === "agent");
        const dlHit = deadLoopGuard.recordIteration(newEntries);
        if (dlHit.tripped) {
          this.earlyStopDetail = dlHit.earlyStopDetail;
          this.appendSystem(
            `All mappers produced empty/junk output for ${dlHit.consecutive} consecutive cycles — ending map-reduce early.`,
          );
          break;
        }

        // Phase B (Task #97): if every mapper signalled COMPLETE in
        // this cycle's MAP phase, there's nothing new to reduce next
        // cycle. Force the upcoming reducer pass to be tagged as the
        // synthesis (since it's now the final reducer output) and
        // break after.
        const allComplete =
          mappers.length > 0 &&
          mappers.every((m) => this.mappersComplete.has(m.id));
        const isEarlyStop = allComplete && r < cfg.rounds;

        // REDUCE — reducer sees full transcript (including all mapper
        // reports from this cycle) and produces a synthesis.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: REDUCE phase — reducer synthesizing.`);
        await this.runReducerTurn(reducer, r, cfg.rounds, isEarlyStop || undefined, cfg.userDirective);

        if (cfg.postSynthesisCritique) {
          const lastReducerEntry = [...this.transcript]
            .reverse()
            .find(e => e.role === "agent" && e.agentIndex === 1);
          const synthText = lastReducerEntry?.text;
          if (synthText) {
            const proposals = this.transcript
              .filter(e => e.role === "agent" && e.agentIndex !== 1)
              .slice(-3)
              .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
            const revised = await runPostSynthesisCritique({
              synthesis: synthText,
              proposals,
              criticAgent: this.opts.manager.list()[0] ?? reducer,
              manager: this.opts.manager,
              appendSystem: (text) => this.appendSystem(text),
              stopping: this.stopping,
              runDiscussionAgent: (agent, prompt, opts) => this.runDiscussionAgent(agent, prompt, opts),
              stats: this.stats,
              presetName: "map-reduce",
            });
            if (lastReducerEntry && revised !== synthText) {
              lastReducerEntry.text = revised;
            }
          }
        }

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
            presetName: "map-reduce",
            stopping: this.stopping,
          });
        }

        // T192 (2026-05-04): honor RE-TASK lines from reducer output.
        // Extract them + stash in nextCycleReframings so the next
        // cycle's mappers see the new framing prepended to their
        // prompt. Skipped on the final cycle (no next cycle to honor).
        if (!isEarlyStop && r < cfg.rounds) {
          const lastReducerEntry = [...this.transcript]
            .reverse()
            .find((e) => e.role === "agent" && e.agentIndex === 1);
          if (lastReducerEntry?.text) {
            const reframings = parseReducerReTaskLines(lastReducerEntry.text);
            this.nextCycleReframings = reframings;
            if (reframings.size > 0) {
              const summary = [...reframings.entries()]
                .map(([idx, frame]) => `Mapper ${idx}: ${frame.slice(0, 60)}…`)
                .join("; ");
              this.appendSystem(
                `[T192 reducer re-task] ${reframings.size} mapper(s) reframed for cycle ${r + 1}: ${summary}`,
              );
            }
          }
        }

        if (isEarlyStop) {
          this.earlyStopDetail =
            `all-mappers-complete after cycle ${r}/${cfg.rounds}`;
          this.appendSystem(
            `All ${mappers.length} mappers reported COMPLETE — ending map-reduce early at cycle ${r}/${cfg.rounds}.`,
          );
          break;
        }
      }
      if (!this.stopping) this.appendSystem("Map-reduce run complete.");
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
        emitOutcome: (outcome: any) => this.opts.emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions }),
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
    const {
      mappers,
      reducer,
      slices,
      reframingsThisCycle,
      seedSnapshot,
      round,
      totalRounds,
      userDirective,
    } = input;
    const N = mappers.length;
    // Threshold counts at which to fire intermediate reducer turns.
    // For N=3: thresholds = [1, 2, 3]; for N=6: [2, 4, 6]; for N=9: [3, 6, 9].
    const thresholds = [
      Math.max(1, Math.ceil(N / 3)),
      Math.max(2, Math.ceil((2 * N) / 3)),
      N,
    ].filter((t, i, a) => a.indexOf(t) === i); // dedup if N is small
    let completedCount = 0;
    // Promise that resolves each time a mapper completes; we await it
    // in a loop checking against the threshold list.
    let resolveNext: (() => void) | null = null;
    let pendingNotice: Promise<void> = new Promise((res) => {
      resolveNext = res;
    });
    const notifyCompletion = () => {
      completedCount++;
      // Replace the resolved promise with a fresh one for the next iteration.
      const r = resolveNext;
      resolveNext = null;
      const next = new Promise<void>((res) => {
        resolveNext = res;
      });
      pendingNotice = next;
      r?.();
    };
    // Launch all mapper turns; each notifies on completion.
    const mapperPromises = mappers.map((m, i) => {
      const mySlice = slices[i] ?? [];
      const reframing = reframingsThisCycle.get(m.index);
      // Stagger the launch slightly to avoid the cold-start race.
      const startDelay = i * 150;
      return new Promise<void>((res) => {
        setTimeout(() => {
          if (this.stopping) {
            notifyCompletion();
            res();
            return;
          }
          this.runMapperTurn(
            m,
            round,
            totalRounds,
            mySlice,
            seedSnapshot,
            userDirective,
            reframing,
          )
            .catch(() => {
              // mapper-turn errors already log inside runMapperTurn;
              // count completion regardless so we don't deadlock.
            })
            .finally(() => {
              notifyCompletion();
              res();
            });
        }, startDelay);
      });
    });

    // Schedule intermediate reducer turns AS THRESHOLDS HIT, in
    // parallel with remaining mappers. The final reducer turn is the
    // last threshold (N) and lands AFTER all mappers complete.
    let nextThresholdIdx = 0;
    while (nextThresholdIdx < thresholds.length) {
      const target = thresholds[nextThresholdIdx]!;
      // Wait until completedCount reaches the threshold.
      while (completedCount < target && !this.stopping) {
        await pendingNotice;
      }
      if (this.stopping) break;
      const isFinalThreshold = nextThresholdIdx === thresholds.length - 1;
      this.appendSystem(
        `[T199 streaming reducer] firing reduce at ${completedCount}/${N} mappers complete (threshold ${nextThresholdIdx + 1}/${thresholds.length}${isFinalThreshold ? ", FINAL" : ""}).`,
      );
      // Fire reducer turn. Don't await mappers yet — they may still
      // be running; reducer sees what's in the transcript so far.
      // We do await the reducer turn so subsequent threshold checks
      // happen against fresh state.
      await this.runReducerTurn(
        reducer,
        round,
        totalRounds,
        isFinalThreshold || undefined,
        userDirective,
      );
      nextThresholdIdx++;
    }
    // Drain any remaining mappers so we don't return while their
    // outputs are still landing in the transcript.
    await Promise.all(mapperPromises);
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
      const stripped = stripAgentText(text);
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
