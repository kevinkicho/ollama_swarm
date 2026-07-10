// Map-reduce loop body (slicing + map/reduce cycles) — extracted from MapReduceRunner.loop.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import { buildImportGraph, clusterByImports } from "./importGraph.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { staggerStart } from "./staggerStart.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import {
  SKIP_ENTRIES,
  sliceRoundRobin,
  sliceSizeBalanced,
  parseReducerReTaskLines,
} from "./mapReducePromptHelpers.js";
import { runCouncilMapperSlice, type CouncilMapperResult } from "./mapReduceCouncilMapper.js";
import { notifyGuardTrip } from "./guardNotify.js";
import {
  buildCrossMapperContextBlock,
  selectFindingsForMapper,
  type MapperFinding,
} from "./midCycleBroadcast.js";

export interface MapReduceLoopHost {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  transcript: TranscriptEntry[];
  mappersComplete: Set<string>;
  stats: any;
  getStopping: () => boolean;
  getNextCycleReframings: () => Map<number, string>;
  setNextCycleReframings: (m: Map<number, string>) => void;
  setMapperSlices: (s: Record<string, string[]>) => void;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string, summary?: unknown) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: unknown) => Promise<string>;
  runStreamingMapReduce: (input: {
    mappers: Agent[];
    reducer: Agent;
    slices: string[][];
    reframingsThisCycle: Map<number, string>;
    seedSnapshot: readonly TranscriptEntry[];
    round: number;
    totalRounds: number;
    userDirective?: string;
  }) => Promise<void>;
  runMapperTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    slice: readonly string[],
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    reframing?: string,
  ) => Promise<void>;
  runReducerTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    isFinal?: true,
    userDirective?: string,
  ) => Promise<void>;
  getRunId?: () => string | undefined;
  getBrainService?: () =>
    | { injectSuggestion?: (runId: string, s: { title: string; text: string; category?: string }) => void }
    | null
    | undefined;
}

export async function runMapReduceLoopBody(
  host: MapReduceLoopHost,
  cfg: RunConfig,
  clonePath: string,
): Promise<void> {
    const agents = host.manager.list();
    const reducer = agents.find((a) => a.index === 1);
    const mappers = agents.filter((a) => a.index > 1);
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
        const allFiles = await host.repos.listRepoFiles(clonePath, {
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
            host.appendSystem(
              `[T197 import-graph slicing] one cluster holds ${maxSize}/${tsJsFiles.length} files (> 70%) — falling back to round-robin slicing.`,
            );
          } else {
            slices = candidate;
            slicingMode = "import-graph";
          }
        } else {
          host.appendSystem(
            `[T197 import-graph slicing] only ${tsJsFiles.length} TS/JS files (< 2× mappers) — falling back to round-robin slicing.`,
          );
        }
      } catch (err) {
        host.appendSystem(
          `[T197 import-graph slicing] failed (${err instanceof Error ? err.message : String(err)}) — falling back to round-robin.`,
        );
      }
    }
    const topLevel = await host.repos.listTopLevel(clonePath);
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
        const allFiles = await host.repos.listRepoFiles(clonePath, {
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
        host.appendSystem(
          `[T-Item-MapPart size-balanced] weights=${weights.join(",")}; LPT-greedy assignment.`,
        );
      } catch (err) {
        host.appendSystem(
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
    host.appendSystem(
      `Repo slicing: ${slicingDesc} across ${mappers.length} mappers.`,
    );
    // Phase 2d: stash + emit slice assignments so CoveragePanel can
    // render the tree view. Keyed by agentId for consistency with
    // other per-agent maps (latency etc.).
    const slicesById: Record<string, string[]> = {};
    for (let i = 0; i < mappers.length; i++) {
      slicesById[mappers[i].id] = slices[i] ?? [];
    }
    host.setMapperSlices(slicesById);
    host.emit({ type: "mapper_slices", slices: slicesById });

    // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
    const tokenBaseline = snapshotLifetimeTokens();
    const deadLoopGuard = new OutputEmptyDeadLoopGuard({
      roleLabel: "mappers",
      unit: "cycle",
    });

    for (let r = 1; r <= cfg.rounds; r++) {
      if (!host.checkRoundBudget(cfg, "cycle", r, tokenBaseline)) break;

      host.appendSystem(`Cycle ${r}/${cfg.rounds}: MAP phase — mappers inspecting slices in parallel.`);

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
      const seedSnapshot = host.transcript.filter((e) => e.role === "system");
      const transcriptLenBefore = host.transcript.length;
      // T192 (2026-05-04): pull this cycle's reframings (set by the
      // PREVIOUS cycle's reducer turn). Empty on cycle 1 always.
      // Cleared after we read them so cycle r+2 doesn't get stale
      // framings from cycle r.
      const reframingsThisCycle = host.getNextCycleReframings();
      host.setNextCycleReframings(new Map());
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
          if (host.getStopping()) break;
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
              host.runDiscussionAgent(agent, prompt, opts),
            stats: host.stats,
            appendSystem: (text) => host.appendSystem(text),
            presetName: "map-reduce",
            stopping: host.getStopping(),
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
            host.transcript.push(entry);
            host.emit({ type: "transcript_append", entry });
            host.emit({ type: "agent_streaming_end", agentId: mappers[i]!.id });
          }
        }
      } else if (cfg.streamingReducer && mappers.length >= 3) {
        await host.runStreamingMapReduce({
          mappers,
          reducer,
          slices,
          reframingsThisCycle,
          seedSnapshot,
          round: r,
          totalRounds: cfg.rounds,
          userDirective: cfg.userDirective,
        });
      } else if (cfg.midCycleBroadcast) {
        // Q9: sequential mappers so high-confidence findings can flow
        // into later mappers' prompts this cycle.
        host.appendSystem(
          "[Q9] Mid-cycle broadcast ON — mappers run sequentially so high-confidence findings reach later slices.",
        );
        const findingPool: MapperFinding[] = [];
        for (let i = 0; i < mappers.length; i++) {
          if (host.getStopping()) break;
          const m = mappers[i]!;
          const mySlice = slices[i] ?? [];
          const reframing = reframingsThisCycle.get(m.index);
          const broadcast = selectFindingsForMapper({
            pool: findingPool,
            receivingMapperIndex: m.index,
          });
          const crossBlock = buildCrossMapperContextBlock(broadcast);
          const mergedReframing = [reframing, crossBlock].filter(Boolean).join("\n\n") || undefined;
          const lenBefore = host.transcript.length;
          await host.runMapperTurn(
            m,
            r,
            cfg.rounds,
            mySlice,
            seedSnapshot,
            cfg.userDirective,
            mergedReframing,
          );
          // Heuristic: treat substantial non-empty mapper text as confidence 7 findings.
          for (const e of host.transcript.slice(lenBefore)) {
            if (e.role !== "agent" || e.agentIndex !== m.index) continue;
            const text = (e.text ?? "").trim();
            if (text.length < 40) continue;
            findingPool.push({
              fromMapperIndex: m.index,
              text: text.slice(0, 280),
              confidence: 7,
            });
          }
        }
      } else {
        await staggerStart(mappers, (m, i) => {
          const mySlice = slices[i] ?? [];
          const reframing = reframingsThisCycle.get(m.index);
          return host.runMapperTurn(m, r, cfg.rounds, mySlice, seedSnapshot, cfg.userDirective, reframing);
        });
      }
      if (host.getStopping()) break;
      // Task #146: dead-loop guard. If every mapper produced empty/junk
      // output this cycle, count toward break threshold.
      // 2026-05-03 (Phase B): logic extracted to OutputEmptyDeadLoopGuard.
      const newEntries = host.transcript
        .slice(transcriptLenBefore)
        .filter((e) => e.role === "agent");
      const dlHit = deadLoopGuard.recordIteration(newEntries);
      if (dlHit.tripped) {
        host.setEarlyStopDetail(dlHit.earlyStopDetail);
        host.appendSystem(
          `All mappers produced empty/junk output for ${dlHit.consecutive} consecutive cycles — ending map-reduce early.`,
        );
        notifyGuardTrip({
          kind: "output-empty",
          detail: dlHit.earlyStopDetail ?? "mappers-silenced",
          runId: host.getRunId?.() ?? cfg.runId,
          appendSystem: (t, s) => host.appendSystem(t, s),
          getBrainService: host.getBrainService,
        });
        break;
      }

      // Phase B (Task #97): if every mapper signalled COMPLETE in
      // this cycle's MAP phase, there's nothing new to reduce next
      // cycle. Force the upcoming reducer pass to be tagged as the
      // synthesis (since it's now the final reducer output) and
      // break after.
      const allComplete =
        mappers.length > 0 &&
        mappers.every((m) => host.mappersComplete.has(m.id));
      const isEarlyStop = allComplete && r < cfg.rounds;

      // REDUCE — reducer sees full transcript (including all mapper
      // reports from this cycle) and produces a synthesis.
      host.appendSystem(`Cycle ${r}/${cfg.rounds}: REDUCE phase — reducer synthesizing.`);
      await host.runReducerTurn(reducer, r, cfg.rounds, isEarlyStop || undefined, cfg.userDirective);

      if (cfg.postSynthesisCritique) {
        const lastReducerEntry = [...host.transcript]
          .reverse()
          .find(e => e.role === "agent" && e.agentIndex === 1);
        const synthText = lastReducerEntry?.text;
        if (synthText) {
          const proposals = host.transcript
            .filter(e => e.role === "agent" && e.agentIndex !== 1)
            .slice(-3)
            .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
          const revised = await runPostSynthesisCritique({
            synthesis: synthText,
            proposals,
            criticAgent: host.manager.list().find((a) => a.index === 1) ?? reducer,
            manager: host.manager,
            appendSystem: (text) => host.appendSystem(text),
            stopping: host.getStopping(),
            runDiscussionAgent: (agent, prompt, opts) => host.runDiscussionAgent(agent, prompt, opts),
            stats: host.stats,
            presetName: "map-reduce",
          });
          if (lastReducerEntry && revised !== synthText) {
            lastReducerEntry.text = revised;
          }
        }
      }

      if (cfg.postRoundCritique) {
        await maybeRunPostRoundCritique({
          agents: host.manager.list(),
          round: r,
          totalRounds: cfg.rounds,
          transcript: host.transcript,
          userDirective: cfg.userDirective,
          enabled: cfg.postRoundCritique ?? false,
          runDiscussionAgent: (agent, prompt, opts) => host.runDiscussionAgent(agent, prompt, opts),
          stats: host.stats,
          appendSystem: (text, summary) => host.appendSystem(text, summary),
          presetName: "map-reduce",
          stopping: host.getStopping(),
        });
      }

      // T192 (2026-05-04): honor RE-TASK lines from reducer output.
      // Extract them + stash in nextCycleReframings so the next
      // cycle's mappers see the new framing prepended to their
      // prompt. Skipped on the final cycle (no next cycle to honor).
      if (!isEarlyStop && r < cfg.rounds) {
        const lastReducerEntry = [...host.transcript]
          .reverse()
          .find((e) => e.role === "agent" && e.agentIndex === 1);
        if (lastReducerEntry?.text) {
          const reframings = parseReducerReTaskLines(lastReducerEntry.text);
          host.setNextCycleReframings(reframings);
          if (reframings.size > 0) {
            const summary = [...reframings.entries()]
              .map(([idx, frame]) => `Mapper ${idx}: ${frame.slice(0, 60)}…`)
              .join("; ");
            host.appendSystem(
              `[T192 reducer re-task] ${reframings.size} mapper(s) reframed for cycle ${r + 1}: ${summary}`,
            );
          }
        }
      }

      if (isEarlyStop) {
        host.setEarlyStopDetail(
          `all-mappers-complete after cycle ${r}/${cfg.rounds}`,
        );
        host.appendSystem(
          `All ${mappers.length} mappers reported COMPLETE — ending map-reduce early at cycle ${r}/${cfg.rounds}.`,
        );
        break;
      }
    }
    if (!host.getStopping()) host.appendSystem("Map-reduce run complete.");
}
