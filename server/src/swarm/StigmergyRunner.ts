import { randomUUID } from "node:crypto";
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
import { formatChatReceipt } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import type { ImportGraph } from "./importGraph.js";
import { detectExplorationGaps, formatExplorationGapsMarkdown } from "./stigmergyExplorationGap.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { buildStigmergySeedMessage } from "./stigmergySeed.js";
import {
  applyAnnotation as applyAnnotationExtracted,
  spreadCrossClusterPheromones as spreadCrossClusterPheromonesExtracted,
  type StigmergyPheromoneHost,
} from "./stigmergyPheromones.js";
import {
  type StigmergyTurnsHost,
  runTerritoryPlanPass as runTerritoryPlanPassExtracted,
  runReportOutPass as runReportOutPassExtracted,
  runExplorerTurn as runExplorerTurnExtracted,
} from "./stigmergyTurns.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { notifyGuardTrip } from "./guardNotify.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import {
  type AnnotationState,
  type ParsedAnnotation,
  SKIP_ENTRIES,
  computeRankingSignature,
  buildHotFilesChainSection,
  formatAnnotations,
  describeSdkError,
} from "./stigmergyPromptHelpers.js";
import { pheromoneHeatmap } from "./pheromoneHeatmap.js";

// Stigmergy / pheromone trails — repo exploration mode.
// No central planner, no role assignment. Agents post annotations on
// files they read (interest 0-10, confidence 0-10, short note). Future
// agents see the running annotation table and pick which file to read
// next based on it — the model decides, the runner just keeps the table.
//
// Per round, agents go in index order (1..N). Each picks ONE file to
// inspect, reads it, returns a structured annotation. Runner parses,
// updates the table, broadcasts. The annotation table is included in
// the next agent's prompt — that's the "pheromone trail."
//
// `rounds` = how many exploration passes through agents. Total turns =
// rounds × agentCount. Discussion-only, no file edits.
export class StigmergyRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Stigmergy"; }

  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.

  // The annotation table — the shared "pheromone" state. File path →
  // aggregated annotation. Updated after each agent's turn.
  private annotations = new Map<string, AnnotationState>();
  // T197 (2026-05-04): import graph for cross-cluster discovery.
  // Built lazily on first applyAnnotation call when cfg.crossClusterDiscovery
  // is set. null = not yet built; empty Map = built but no edges
  // (degenerate repo).
  private importGraphCache: ImportGraph | null = null;
  // 2026-05-02 (improvement #2): per-explorer territory assignment from
  // the lead's pre-round-1 plan. Map agentIndex → territory description.
  // Empty when the lead's plan failed; explorers wander unguided in
  // that case (back-compat).
  private territoryAssignments = new Map<number, string>();
  // Phase B (Task #98): rolling window of the last N rounds' top-10
  // file-name signatures. Detects "the swarm is no longer learning
  // anything new" — once the visit-graph stabilizes, more rounds just
  // burn tokens reading the same files.
  private rankingHistory: string[] = [];

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  status(): SwarmStatus {
    const base = super.status();
    // Phase 2a: expose the pheromone table for the REST catch-up path
    // so a page refresh mid-run restores the PheromonePanel's state
    // without waiting for the next applyAnnotation to fire over WS.
    const pheromones: Record<string, {
      visits: number;
      avgInterest: number;
      avgConfidence: number;
      latestNote: string;
    }> = {};
    for (const [file, s] of this.annotations.entries()) {
      pheromones[file] = { ...s };
    }
    return { ...base, pheromones };
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.annotations = new Map();
    this.rankingHistory = [];

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "stigmergy",
      minAgents: 2,
      roleResolver: () => "Explorer",
      extraReadyMessage: "All agents are equal explorers — no planner, no roles.",
    });
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
    this.startedAt = Date.now();
    await this.runTrackedLoop(() => this.loop(cfg, destPath));
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const { text, summary } = buildStigmergySeedMessage({ clonePath, cfg, tree });
    this.appendSystem(text, summary);
  }

  private pheromoneHost(): StigmergyPheromoneHost {
    return {
      annotations: this.annotations,
      round: this.round,
      active: this.active,
      importGraphCache: this.importGraphCache,
      setImportGraphCache: (g) => { this.importGraphCache = g; },
      emit: (e) => this.opts.emit(e),
      appendSystem: (t) => this.appendSystem(t),
      listRepoFiles: (p, o) => this.opts.repos.listRepoFiles(p, o),
    };
  }

  private stigmergyTurnsHost(): StigmergyTurnsHost {
    return {
      manager: this.opts.manager,
      emit: (e) => this.opts.emit(e),
      logDiag: this.opts.logDiag,
      transcript: this.transcript,
      annotations: this.annotations,
      territoryAssignments: this.territoryAssignments,
      round: this.round,
      active: this.active,
      stats: this.stats,
      getStopping: () => this.stopping,
      appendSystem: (t, s) => this.appendSystem(t, s as any),
      emitAgentState: (s) => this.emitAgentState(s),
      runAgent: (a, p, o) => this.runAgent(a, p, o),
      applyAnnotation: (ann) => this.applyAnnotation(ann),
    };
  }

  private async loop(cfg: RunConfig, clonePath: string): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const initialEntries = await this.opts.repos.listTopLevel(clonePath);
      const candidatePaths = initialEntries.filter((e) => !SKIP_ENTRIES.has(e));

      // Phase B (Task #98): stability window. Need at least
      // STABILITY_WINDOW rounds of identical top-10 to call it
      // converged. Skip the check until the swarm has had time to
      // explore (MIN_ROUND_FOR_CHECK) — early rounds always look
      // unstable.
      const STABILITY_WINDOW = 3;
      const MIN_ROUND_FOR_CHECK = STABILITY_WINDOW + 2;

      // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
      const tokenBaseline = snapshotLifetimeTokens();
      const deadLoopGuard = new OutputEmptyDeadLoopGuard({
        roleLabel: "explorers",
        unit: "round",
      });

      // 2026-05-02 (improvement #2): pre-round-1 territory-plan pass.
      // Lead agent (index 1) issues per-explorer territory assignments
      // based on directive + repo top-level structure. Best-effort —
      // failure leaves territoryAssignments empty so explorers wander
      // unguided (back-compat).
      if (!this.stopping && cfg.userDirective && agents.length >= 2) {
        try {
          await this.runTerritoryPlanPass(cfg, agents, candidatePaths);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`[improvement #2] Territory plan pass failed (${msg}); explorers will work without assignments.`);
        }
      }

      for (let r = 1; r <= cfg.rounds; r++) {
        if (!this.checkRoundBudget(cfg, "round", r, tokenBaseline)) break;

        const transcriptLenBefore = this.transcript.length;
        for (const agent of agents) {
          if (this.stopping) break;
          await this.runExplorerTurn(agent, r, cfg.rounds, candidatePaths);
        }
        // Task #146: dead-loop guard. If every explorer this round produced
        // empty/junk output, count toward break threshold.
        // 2026-05-03 (Phase B): logic extracted to OutputEmptyDeadLoopGuard.
        if (!this.stopping) {
          const newEntries = this.transcript
            .slice(transcriptLenBefore)
            .filter((e) => e.role === "agent");
          const dlHit = deadLoopGuard.recordIteration(newEntries);
          if (dlHit.tripped) {
            this.earlyStopDetail = dlHit.earlyStopDetail;
            this.appendSystem(
              `All explorers produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending stigmergy early.`,
            );
            notifyGuardTrip({
              kind: "output-empty",
              detail: dlHit.earlyStopDetail ?? "explorers-silenced",
              runId: this.active?.runId,
              appendSystem: (t, s) => this.appendSystem(t, s as any),
              getBrainService: () => this.opts.getBrainService?.() ?? null,
            });
            break;
          }
        }

        // Phase B (Task #98): record this round's ranking, check for
        // stability. Run only when annotations exist (else the empty
        // signature trivially matches itself).
        if (!this.stopping && this.annotations.size > 0 && r < cfg.rounds) {
          const sig = computeRankingSignature(this.annotations, this.round);
          this.rankingHistory.push(sig);
          if (this.rankingHistory.length > STABILITY_WINDOW) {
            this.rankingHistory.shift();
          }
          if (
            r >= MIN_ROUND_FOR_CHECK &&
            this.rankingHistory.length === STABILITY_WINDOW &&
            this.rankingHistory.every((s) => s === this.rankingHistory[0])
          ) {
            this.earlyStopDetail =
              `visit-graph stable for ${STABILITY_WINDOW} rounds (top-10 unchanged)`;
            this.appendSystem(
              `Top-10 unchanged for ${STABILITY_WINDOW} consecutive rounds — ending stigmergy early at round ${r}/${cfg.rounds}.`,
            );
            break;
          }
        }
      }
      if (!this.stopping) {
        this.appendSystem(`Stigmergy run complete. Annotation table:\n${formatAnnotations(this.annotations)}`);
        // Task #80 (2026-04-25): report-out synthesis. Without this,
        // the run ends with the raw annotation table and no human-
        // readable "what did we find" summary. Lead agent ranks files
        // by visits × interest and produces a top-N narrative.
        if (this.annotations.size > 0) {
          await this.runReportOutPass();
        }
      }
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-02 (deliverables initiative): structured markdown.
      if (!this.stopping && cfg.runId) await this.writeStigmergyDeliverable(cfg);
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
            `Stigmergy preset · ${cfg.agentCount} explorers · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
        transcript: this.transcript,
        emitOutcome: (outcome: any) => this.opts.emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions }),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

  // 2026-05-02 (deliverables initiative): stigmergy structured
  // artifact. Sections: top findings (last agent entry tagged
  // stigmergy_report) / pheromone trail (annotation envelopes per
  // explorer turn) / annotation table.
  private async writeStigmergyDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    const reportEntry = [...this.transcript]
      .reverse()
      .find((e) => e.summary?.kind === "stigmergy_report");
    const annotationEntries = this.transcript.filter(
      (e) => e.summary?.kind === "stigmergy_annotation",
    );
    const sections = [
      {
        title: "Top findings (lead report-out)",
        body: reportEntry?.text?.trim() || "_(no report captured)_",
      },
      {
        title: `Pheromone trail (${annotationEntries.length} annotation${annotationEntries.length === 1 ? "" : "s"})`,
        body: annotationEntries.length > 0
          ? annotationEntries
              .map((e) => {
                const s = e.summary;
                if (s?.kind !== "stigmergy_annotation") return e.text.trim();
                return `### ${s.file} (interest ${s.interest}/10, confidence ${s.confidence}/10)\n\n${s.note}`;
              })
              .join("\n\n")
          : "_(no annotations captured)_",
      },
      {
        title: `Annotation table (${this.annotations.size} files visited)`,
        body: "```\n" + formatAnnotations(this.annotations) + "\n```",
      },
    ];
    // 2026-05-02 (stigmergy improvement #3): top-down exploration gap
    // check. Compares directive's path-mentions + repo's top-level dirs
    // against actually-annotated files. Surfaces "you missed this".
    let repoFiles: string[] = [];
    try {
      repoFiles = await this.opts.repos.listRepoFiles(cfg.localPath, { maxFiles: 500 });
    } catch {
      repoFiles = [];
    }
    const gaps = detectExplorationGaps({
      directive: cfg.userDirective ?? "",
      annotatedFiles: [...this.annotations.keys()],
      repoFiles,
    });
    sections.push({
      title: "Exploration gaps (top-down directive check)",
      body: formatExplorationGapsMarkdown(gaps),
    });
    // T187 (2026-05-04): hot-files section + explicit blackboard chain
    // recommendation. The standard T2.3 chain hint extracts the top
    // next-action from the deliverable text — when that text is
    // structured as "Recommended blackboard chain target: hot files X,
    // Y, Z," the hint points at file-level work the blackboard preset
    // can actually act on.
    sections.push({
      title: "Hot files (top by pheromone score) — blackboard chain target",
      body: buildHotFilesChainSection(this.annotations, this.round),
    });
    // 2026-05-02 (quality levers #1+#3): augment with critic + next-actions.
    const lead = this.opts.manager.list().find((a) => a.index === 1) ?? null;
    const augmented = await runQualityPasses({
      baseSections: sections,
      rubric: null,
      criticAgent: lead,
      manager: this.opts.manager,
    });
    writeDeliverableAndEmit(
      {
        preset: "stigmergy",
        runId: cfg.runId,
        clonePath: cfg.localPath,
        title: "Stigmergy coverage report",
        subtitle: `${cfg.agentCount} explorer${cfg.agentCount === 1 ? "" : "s"} across ${this.round}/${cfg.rounds} round${cfg.rounds === 1 ? "" : "s"}${this.earlyStopDetail ? " · early-stop" : ""}`,
        sections: augmented,
      },
      { transcript: this.transcript, emit: this.opts.emit },
    );
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  // 2026-05-03 (Phase C): writeSummary body extracted to shared helper.
  // Task #80: report-out pass at end of run. Routes through agent-1
  // with the ranked annotation table and asks for a top-N narrative.
  // Tagged with summary kind "stigmergy_report" so the modal renders
  // distinctively. Failure is non-fatal — the raw annotation table
  // already landed in transcript above.
  // 2026-05-02 (improvement #2): pre-round-1 territory planning. Lead
  // agent (index 1) receives the directive + repo top-level structure +
  // explorer count, returns per-explorer territory assignments. Stored
  // in territoryAssignments; threaded into per-explorer prompts in
  // runExplorerTurn. Best-effort — failure leaves the map empty so
  // explorers wander unguided (back-compat with pure-stigmergy
  // behavior).
  private async runTerritoryPlanPass(
    cfg: RunConfig,
    agents: readonly Agent[],
    candidatePaths: readonly string[],
  ): Promise<void> {
    return runTerritoryPlanPassExtracted(this.stigmergyTurnsHost(), cfg, agents, candidatePaths);
  }

  private async runReportOutPass(): Promise<void> {
    return runReportOutPassExtracted(this.stigmergyTurnsHost());
  }

  private async runExplorerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    candidatePaths: readonly string[],
  ): Promise<void> {
    return runExplorerTurnExtracted(
      this.stigmergyTurnsHost(),
      agent,
      round,
      totalRounds,
      candidatePaths,
    );
  }

  private applyAnnotation(ann: ParsedAnnotation): void {
    applyAnnotationExtracted(this.pheromoneHost(), ann, {
      onHighInterest: (file, interest) => {
        void this.spreadCrossClusterPheromones(file, interest);
      },
    });
  }

  private async spreadCrossClusterPheromones(
    seedFile: string,
    seedInterest: number,
  ): Promise<void> {
    await spreadCrossClusterPheromonesExtracted(
      this.pheromoneHost(),
      seedFile,
      seedInterest,
    );
  }

  /** #303: optional transform applied to the post-strip text BEFORE
   *  the transcript entry is pushed. Lets callers (currently only
   *  runExplorerTurn) remove envelope JSON from the visible text and
   *  attach a structured TranscriptEntrySummary so the UI bubble
   *  renders a card instead of raw markup. */
  private async runAgent(
    agent: Agent,
    prompt: string,
    opts?: {
      transformEntry?: (text: string) => { text: string; summary?: TranscriptEntrySummary };
    },
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
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = await promptWithFailoverAuto(agent, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
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
        },
      });
      const diagCtx = {
        runner: "stigmergy",
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
      const strippedAgent = finalizeAgentOutput(text, { role: "general" });
      let entryText = strippedAgent.finalText || "(empty response)";
      let entrySummary: TranscriptEntrySummary | undefined;
      // #303: apply caller-supplied transform (e.g. strip stigmergy
      // annotation JSON from visible text + attach structured kind).
      if (opts?.transformEntry) {
        const transformed = opts.transformEntry(entryText);
        entryText = transformed.text;
        entrySummary = transformed.summary;
      }
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: entryText,
        ts: Date.now(),
        ...(entrySummary ? { summary: entrySummary } : {}),
        ...(strippedAgent.thoughts.length > 0 ? { thoughts: strippedAgent.thoughts } : {}),
        ...(strippedAgent.toolCalls.length > 0 ? { toolCalls: strippedAgent.toolCalls } : {}),
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

}
