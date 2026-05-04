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
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { selectModelForRole } from "./dynamicModelRoute.js";
import { defaultRoleForIndex } from "../../../shared/src/topology.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
// T197 (2026-05-04): smart slicing by import graph (opt-in via cfg.importGraphSlicing).
import { buildImportGraph, clusterByImports } from "./importGraph.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { staggerStart } from "./staggerStart.js";
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
export class MapReduceRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase 2d: mapper slice assignments, keyed by agentId. Empty map
  // pre-run or if slicing hasn't happened yet.
  private mapperSlices: Record<string, string[]> = {};
  // T192 (2026-05-04): per-mapper-index reframing instructions extracted
  // from the previous reducer turn's RE-TASK lines. Cleared at start
  // of each cycle, populated after reducer turn, threaded into next
  // cycle's mapper prompts. Keyed by mapper agentIndex (NOT id).
  private nextCycleReframings: Map<number, string> = new Map();
  // Phase B (Task #97): set of mapper agent IDs that have flagged
  // their slice complete. When this matches the live mapper set, the
  // run can stop early — no point reducing the same content again.
  private mappersComplete = new Set<string>();
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
      // Phase 2d: mapper slice assignments for CoveragePanel catch-up.
      mapperSlices: { ...this.mapperSlices },
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
    this.mappersComplete = new Set();
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
    if (ready.length < 3) {
      throw new Error(
        `Map-reduce requires at least 3 agents (1 reducer + 2 mappers). Only ${ready.length} spawned.`,
      );
    }
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. Agent 1 is the REDUCER; agents 2..${cfg.agentCount} are MAPPERS.`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: "map-reduce",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: (a) => (a.index === 1 ? "Reducer" : "Mapper"),
      }),
    );
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg, destPath);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    await this.opts.manager.killAll();
    this.setPhase("stopped");
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
        if (cfg.streamingReducer && mappers.length >= 3) {
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
      });
    }
  }

  // 2026-05-02 (deliverables initiative): map-reduce structured
  // artifact. Pulls the final reducer synthesis (kind: mapreduce_synthesis)
  // + per-mapper findings from the transcript.
  // 2026-05-02 (map-reduce improvement #2): directive-aware. When a
  // directive is set, the deliverable opens with a Directive section
  // and the title/subtitle reflect "answering <directive>" framing.
  private async writeMapReduceDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective(cfg);
    const reducerSynthesis = [...this.transcript]
      .reverse()
      .find((e) => e.summary?.kind === "mapreduce_synthesis");
    const mapperEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex !== 1,
    );
    const sections: Array<{ title: string; body: string }> = [];
    const directiveSection = maybeDirectiveSection(dirCtx);
    if (directiveSection) sections.push(directiveSection);
    sections.push(
      {
        title: pickAnswerSectionTitle(dirCtx, {
          withDirective: "Answer to directive",
          withoutDirective: "Final reducer synthesis",
        }),
        body: reducerSynthesis?.text?.trim() || "_(no reducer synthesis captured)_",
      },
      {
        title: `Per-mapper findings (${mapperEntries.length} entries)`,
        body:
          mapperEntries.length > 0
            ? mapperEntries
                .map((e) => `### Mapper ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
                .join("\n\n")
            : "_(no mapper findings)_",
      },
    );
    // 2026-05-02 (quality levers #1+#3): augment with critic + next-actions.
    const reducer = this.opts.manager.list().find((a) => a.index === 1) ?? null;
    const augmented = await runQualityPasses({
      baseSections: sections,
      rubric: null,
      criticAgent: reducer,
      manager: this.opts.manager,
    });
    const subtitleBase = `1 reducer + ${cfg.agentCount - 1} mappers across ${this.round}/${cfg.rounds} cycle${cfg.rounds === 1 ? "" : "s"}${this.earlyStopDetail ? " · early-stop" : ""}`;
    writeDeliverableAndEmit(
      {
        preset: "map-reduce",
        runId: cfg.runId,
        clonePath: cfg.localPath,
        title: pickDeliverableTitle(dirCtx, {
          withDirective: "Map-reduce: directive answer",
          withoutDirective: "Map-reduce report",
        }),
        subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
        sections: augmented,
      },
      { transcript: this.transcript, emit: this.opts.emit },
    );

    // T2.2 (2026-05-04): opt-in wrap-up apply phase. Reducer (agent-1)
    // doubles as implementer.
    if (reducer) {
      await maybeRunWrapUpApply({
        cfg,
        presetName: "map-reduce",
        agent: reducer,
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

// Skip repo entries that don't contribute to understanding: VCS metadata,
// node_modules, build output. The mapper listing already truncated by
// RepoService.listTopLevel; this is a further filter on the labeled slice.
//
// Task #106 (2026-04-25): expanded with trivial config files that
// caused "tiny single-file slice" collapse in run 2bcf662f — when a
// mapper's slice was just `.editorconfig`, the model latched onto its
// numeric values and emitted just "0.5", "11.4", etc. These configs
// rarely contain anything a swarm needs to reason about; skipping them
// keeps slices semantically meaningful even at small mapper counts.
const SKIP_ENTRIES = new Set([
  ".git/", ".git", "node_modules/", "node_modules", ".DS_Store",
  // Task #106 (2026-04-25):
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".prettierrc", ".prettierrc.json", ".prettierrc.js",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js",
  ".env.example",
  "LICENSE", "LICENSE.md", "LICENSE.txt",
]);

// Phase B (Task #97): scan a mapper's response for the
// "COMPLETE: true|false" declaration. Looks at the LAST 3 non-blank
// lines, then within each line searches for the COMPLETE: pattern
// anywhere (not just line-start) — observed in v1 validation that
// the model sometimes prefixes with "Final line:" (literal echo of
// the instruction), so an anchored regex would miss it.
export function parseMapperComplete(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-3);
  for (const line of tail) {
    const m = /\bcomplete\s*:\s*(true|false)\b/i.exec(line);
    if (m) return m[1].toLowerCase() === "true";
  }
  return false;
}

// Round-robin partition of `entries` into `k` slices. Exported so tests
// can lock down the distribution (every entry appears in exactly one
// slice; slices differ in length by at most 1).
export function sliceRoundRobin<T>(entries: readonly T[], k: number): T[][] {
  if (k <= 0) return [];
  const slices: T[][] = Array.from({ length: k }, () => []);
  entries.forEach((e, i) => slices[i % k].push(e));
  return slices;
}

// T-Item-MapPart (2026-05-04): size-balanced slicing — greedy LPT
// ("longest processing time first"). Each entry has a weight (e.g.,
// recursive file count); sort entries descending by weight, then
// assign each to the currently-lightest-loaded mapper. Bounds the
// max-load-vs-min-load ratio better than round-robin when weights
// are skewed (one giant `node_modules`-style dir + many tiny ones).
//
// Pure — exported for tests.
export function sliceSizeBalanced<T>(
  entries: readonly { item: T; weight: number }[],
  k: number,
): T[][] {
  if (k <= 0) return [];
  const slices: T[][] = Array.from({ length: k }, () => []);
  const loads: number[] = Array.from({ length: k }, () => 0);
  // Sort descending by weight so LPT places heavy items first.
  const sorted = [...entries].sort((a, b) => b.weight - a.weight);
  for (const { item, weight } of sorted) {
    // Pick the slice with the smallest current load. Tie-break by
    // lowest index for determinism.
    let pickIdx = 0;
    let minLoad = loads[0];
    for (let i = 1; i < k; i++) {
      if (loads[i] < minLoad) {
        minLoad = loads[i];
        pickIdx = i;
      }
    }
    slices[pickIdx].push(item);
    loads[pickIdx] += weight;
  }
  return slices;
}

// 2026-05-04 (idea T174): per-mapper lens specialization. Each mapper
// gets a different reading lens (security/performance/correctness/UX/
// architecture/testability) so 4-6 mappers cover 4-6 dimensions
// instead of all reading the same way against different files. The
// reducer then synthesizes across dimensions, not just across slices.
//
// Lens cycles by mapperIndex modulo catalog length. mapperIndex starts
// at 2 (agent-1 is reducer) so we offset by -2 to start lens cycle at
// MAPPER_LENSES[0].
export interface MapperLens {
  /** Short id used in report sections + reducer aggregation. */
  id: string;
  /** Title shown to the mapper at top of its prompt. */
  title: string;
  /** What the mapper looks for under this lens. ~3 short bullets. */
  guidance: readonly string[];
}
export const MAPPER_LENSES: readonly MapperLens[] = [
  {
    id: "correctness",
    title: "Correctness lens",
    guidance: [
      "Look for bugs: off-by-one, null deref, unhandled error paths, race conditions, edge cases not tested.",
      "Watch for assumptions that aren't validated: \"this can never be empty\", \"the API always returns X\".",
      "Surface code paths that look right but lack a test that would catch a regression.",
    ],
  },
  {
    id: "security",
    title: "Security lens",
    guidance: [
      "Look for: input not validated, secrets in source, sql/cmd injection vectors, auth/authz holes, unsafe deps.",
      "Watch for default-allow patterns where default-deny is safer.",
      "Surface trust boundaries crossed without explicit checks.",
    ],
  },
  {
    id: "performance",
    title: "Performance lens",
    guidance: [
      "Look for: N+1 queries, sync I/O on hot paths, unbounded allocations, accidental quadratics, repeated parsing.",
      "Watch for blocking ops in async contexts and unbounded retry loops.",
      "Surface where caching or batching would change the order of magnitude.",
    ],
  },
  {
    id: "architecture",
    title: "Architecture lens",
    guidance: [
      "Look for: layering violations, circular deps, modules that know too much about each other, leaky abstractions.",
      "Watch for premature abstraction (helpers used once) and missing abstraction (3+ near-duplicates).",
      "Surface decisions that lock the project into a path that'll be expensive to reverse.",
    ],
  },
  {
    id: "testability",
    title: "Testability lens",
    guidance: [
      "Look for: untested critical paths, code that's hard to test (heavy I/O coupling, hidden dependencies, mocked-database gaps).",
      "Watch for tests that pass because they mock too much, not because the code works.",
      "Surface integration points that lack any end-to-end coverage.",
    ],
  },
  {
    id: "ux-and-docs",
    title: "UX / documentation lens",
    guidance: [
      "Look for: error messages that won't help a user, accessibility gaps in frontend, default values that surprise.",
      "Watch for docs that disagree with the code (README claims a feature that the code doesn't implement).",
      "Surface places where a one-paragraph explanation would save the next reader 30 minutes.",
    ],
  },
];

/** Pick the lens for a given mapper. mapperIndex starts at 2
 *  (agent-1 is reducer). Cycles through MAPPER_LENSES so a swarm
 *  with > 6 mappers wraps. */
export function lensForMapper(mapperIndex: number): MapperLens {
  const offset = Math.max(0, mapperIndex - 2);
  return MAPPER_LENSES[offset % MAPPER_LENSES.length]!;
}

export function buildMapperPrompt(
  mapperIndex: number,
  round: number,
  totalRounds: number,
  slice: readonly string[],
  seedSnapshot: readonly TranscriptEntry[],
  userDirective?: string,
  // T192 (2026-05-04): optional reframing from the previous reducer
  // turn's RE-TASK line. Surfaced as a high-priority directive ABOVE
  // the lens block so the mapper applies the new framing this cycle.
  reframing?: string,
): string {
  const seedText = seedSnapshot.map((e) => `[SYSTEM] ${e.text}`).join("\n\n");
  const sliceList = slice.length === 0 ? "(empty slice)" : slice.join(", ");
  // 2026-05-04 (idea T174): per-mapper lens.
  const lens = lensForMapper(mapperIndex);

  // 2026-05-02 (map-reduce improvement #1): when a directive is set,
  // mapper's job changes from "tell me everything about your slice" to
  // "find what in your slice bears on the directive". The "no relevant
  // findings" valve is critical — without it mappers with off-topic
  // slices will hallucinate relevance to seem useful.
  // 2026-05-03 (Phase A): directive block extracted to shared helper.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this map-reduce sweep is answering)",
    framingLines: [
      "**YOUR JOB UNDER THE DIRECTIVE:** Find what in YOUR slice bears on the directive. NOT what your slice is in general — only what's RELEVANT to the directive.",
      "**\"NO RELEVANT FINDINGS\" IS A VALID ANSWER.** If your slice has nothing that bears on the directive, report that explicitly — `My slice (path/, path/) contains no findings relevant to the directive: <one-line why not>`. Do NOT invent relevance to seem useful.",
    ],
  });

  const reportInstructions = dirCtx.hasDirective
    ? [
        "Produce a CONCRETE report (under ~300 words) covering:",
        "- For each finding: which file, what's relevant to the directive, what to do about it.",
        "- Cite file paths (e.g. `src/foo.ts:42`) for every claim. No claim without a file:line attribution.",
        "- If your slice has NOTHING relevant: one short paragraph explaining what your slice IS and why it doesn't bear on the directive. That is the full report — don't pad.",
      ]
    : [
        "Produce a CONCRETE report (under ~300 words) covering:",
        "- What each entry in your slice is (purpose / role).",
        "- Anything noteworthy: obvious defects, design choices, TODOs, test coverage gaps, interesting patterns.",
        "- Cite file paths (e.g. `src/foo.ts:42`) for any claim you make.",
      ];

  return [
    `You are Mapper Agent ${mapperIndex} in a map-reduce swarm.`,
    `This is cycle ${round}/${totalRounds}. You cannot see the reducer's output or any peer mapper's report — that is deliberate, so your report is independent.`,
    "",
    ...directiveBlock,
    `Your slice of the repo: ${sliceList}`,
    "Inspect ONLY the entries in your slice. Do not read or reference files outside your slice.",
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to actually read the assigned entries.",
    "",
    // T192 (2026-05-04): reducer reframing — when set, prepended above
    // the lens block as a high-priority cycle-specific instruction.
    // Tells the mapper "the previous reducer noticed X — this cycle,
    // re-examine your slice through that frame."
    ...(reframing && reframing.trim().length > 0
      ? [
          `### REDUCER RE-TASK FOR YOUR SLICE THIS CYCLE`,
          `The previous reducer flagged you for re-examination with new framing:`,
          `> ${reframing.trim()}`,
          `Apply this framing IN ADDITION TO your standard lens (below). Both signals should shape your findings.`,
          "",
        ]
      : []),
    // 2026-05-04 (idea T174): per-mapper lens. Each mapper biases its
    // reading toward a different dimension so the swarm covers more
    // ground per cycle without re-reading the same files from the
    // same angle.
    `### YOUR LENS THIS CYCLE: ${lens.title} (id: ${lens.id})`,
    `**Read your slice through this lens specifically.** Other mappers cover other lenses; the reducer aggregates across them.`,
    ...lens.guidance.map((g) => `- ${g}`),
    `Tag your findings with their lens: prefix each finding line with \`[${lens.id}]\` so the reducer can group across mappers.`,
    "",
    ...reportInstructions,
    "",
    "Do NOT speculate about entries outside your slice.",
    "",
    // Phase B (Task #97): convergence signal. Mapper declares when
    // its slice is fully understood and further cycles would only
    // re-read the same files. When EVERY mapper reports COMPLETE,
    // the run can end early. Be honest — declaring complete on a
    // partially-understood slice wastes the reducer's time.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  COMPLETE: true   — your slice is fully understood; you have nothing meaningful left to add even with more cycles.",
    "  COMPLETE: false  — there is more to investigate (gaps, ambiguity, unread files in your slice, etc).",
    "",
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
    "",
    `Now respond as Mapper Agent ${mapperIndex}.`,
  ].join("\n");
}

export function buildReducerPrompt(
  round: number,
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Mapper ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const isFinal = round === totalRounds;

  // 2026-05-02 (map-reduce improvement #1): directive-aware synthesis.
  // When directive is set, the synthesis answers the directive directly
  // — Project-picture framing is replaced with Answer-to-directive
  // framing. Mid-cycle gap question becomes "which slice should be
  // re-issued to dig deeper into the directive".
  if (dirCtx.hasDirective) {
    const directiveClosing = isFinal
      ? "4. **Final answer to the directive** — your unified, evidence-backed answer with mapper + file citations. Name the single most important next step."
      : "4. **Coverage gap toward the directive** — name one slice / area no mapper has dug into yet that's likely to bear on the directive. Future cycle should target it.";
    return [
      `You are the REDUCER (Agent 1) in a map-reduce swarm.`,
      `This is the reduce step of cycle ${round}/${totalRounds}. Mapper agents just reported on their assigned slices of the repo.`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the question this map-reduce sweep is answering)",
      }),
      "Your job is to SYNTHESIZE the mappers' findings into an answer to the directive. Do NOT summarize each mapper individually. Look for the things only visible from the reducer's vantage:",
      "  - DIRECT EVIDENCE: mapper findings that directly bear on the directive — list them with file paths.",
      "  - **CROSS-LENS PATTERNS:** mappers report findings tagged with their lens (e.g. `[security]`, `[performance]`, `[correctness]`). Group findings by lens AND by file — when the SAME file gets flagged across multiple lenses, that's a hot spot worth surfacing.",
      "  - SURPRISES: cross-slice findings that change the answer (e.g. Mapper 2's finding recontextualizes Mapper 4's).",
      "  - CONTRADICTIONS: mappers disagreeing about something the directive depends on. Name the mappers and the tension.",
      "  - SLICE GAPS: which mapper's slice contained no relevant findings (`COMPLETE: true` with `no findings relevant`) and whether that's a real gap or just an off-topic slice.",
      "",
      "Produce a synthesis (under ~600 words) structured as:",
      "1. **Answer to directive** — direct response to the user's question, evidence-backed by mapper findings + file paths.",
      "2. **Supporting evidence** — the specific mapper findings that ground your answer (cite Mapper N + file paths).",
      "3. **Tensions / open questions** — contradictions or things mappers couldn't determine that affect the answer's confidence.",
      directiveClosing,
      "",
      "Cite mappers by agent index (e.g. \"Mapper 3 noted…\") and the file paths they cited. Do NOT invent evidence beyond what mappers reported — if the directive can't be answered from the union of slices, say so explicitly.",
      "",
      // T190 (2026-05-04): reducer re-tasking. When a pattern emerges
      // from one mapper that another mapper's slice would benefit from
      // re-examining with fresh framing, the reducer can REQUEST a
      // re-task. Today the runner doesn't act on this (mappers always
      // get their original slice next cycle); the request lands in
      // the transcript so a future runner-side change can honor it.
      ...(isFinal
        ? []
        : [
            "**REDUCER RE-TASK (optional, mid-run only):** If a pattern from one mapper suggests another mapper should re-examine their slice with new framing, end your synthesis with one or more `RE-TASK:` lines:",
            "    RE-TASK: Mapper <N> | new-framing: <one short sentence>",
            "    RE-TASK: Mapper 4 | new-framing: re-examine src/auth/ specifically for shared-state hazards now that Mapper 2 surfaced the singleton pattern in src/db/.",
            "Use sparingly — re-tasking only pays off when the new framing is genuinely different. Today the runner logs these but doesn't auto-redispatch; future work will honor them.",
            "",
          ]),
      "=== TRANSCRIPT ===",
      transcriptText,
      "=== END TRANSCRIPT ===",
      "",
      "Now write your synthesis.",
    ].join("\n");
  }

  // No-directive path: original "tell me about this repo" framing.
  const closingInstruction = isFinal
    ? "4. Close with your final unified picture of the project: what it is, who it's for, and the single most important next step."
    : "4. Name one GAP in coverage — an area no mapper covered well or where their reports disagree — that a future cycle should target.";

  return [
    `You are the REDUCER (Agent 1) in a map-reduce swarm.`,
    `This is the reduce step of cycle ${round}/${totalRounds}. Mapper agents just reported on their assigned slices of the repo.`,
    "",
    "Your job is NOT to summarize each mapper individually — it is to SYNTHESIZE across them. Look for the things only visible from the reducer's vantage:",
    "  - SURPRISES: a finding from one mapper that recontextualizes another's slice (e.g. Mapper 2 found a singleton that explains the duplication Mapper 4 reported).",
    "  - CONTRADICTIONS: places where mappers reached different conclusions about the same area (e.g. Mapper 1 says the API is REST, Mapper 3 says it's gRPC — both can't be right).",
    "  - GAPS: the thing nobody covered well that the union of slices makes obvious.",
    "",
    "Produce a synthesis (under ~500 words) that:",
    "1. **Project picture** — what this codebase IS, who it's for, citing mapper findings.",
    "2. **Cross-slice surprises + contradictions** — what jumped out when you read all reports together. Name the mappers and the specific tension.",
    "3. **What's solid / what's missing** — with mapper + file attributions.",
    closingInstruction,
    "",
    "Cite mappers by their agent index (e.g. \"Mapper 3 noted…\") and by file paths they cited. Do NOT invent evidence beyond what mappers reported. Do NOT just restate each mapper in turn — that's the failure mode this prompt exists to prevent.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis.",
  ].join("\n");
}

// T192 (2026-05-04): parse RE-TASK lines from a reducer's output.
// Format: `RE-TASK: Mapper <N> | new-framing: <one short sentence>`
// (case-insensitive on the keywords; tolerant of leading whitespace +
// optional bullet markers). Returns a Map<mapperIndex, framing>.
// Multiple RE-TASK lines for the same Mapper N → last one wins
// (assumption: reducer wouldn't naturally double-assign; if it did
// the last instruction is the latest thinking).
export function parseReducerReTaskLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!text) return out;
  // Per-line scan — allow leading whitespace, optional bullet/quote
  // markers, then RE-TASK keyword.
  const re = /^[\s>*-]*RE[- ]TASK\s*:\s*Mapper\s+(\d+)\s*\|\s*new[- ]framing\s*:\s*(.+?)$/gim;
  for (const m of text.matchAll(re)) {
    const idx = Number.parseInt(m[1]!, 10);
    const framing = m[2]!.trim();
    if (Number.isFinite(idx) && idx >= 1 && framing.length > 0) {
      out.set(idx, framing);
    }
  }
  return out;
}

