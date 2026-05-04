import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
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
import { formatChatReceipt } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
// T197 (2026-05-04): cross-cluster discovery via import graph.
import {
  buildImportGraph,
  relatedFilesViaImports,
  type ImportGraph,
} from "./importGraph.js";
import { detectExplorationGaps, formatExplorationGapsMarkdown } from "./stigmergyExplorationGap.js";
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
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";

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
export class StigmergyRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
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
  private earlyStopDetail?: string;

  constructor(private readonly opts: RunnerOpts) {}

  status(): SwarmStatus {
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
      pheromones,
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
    this.annotations = new Map();
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.rankingHistory = [];
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
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgentNoOpencode({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length < 2) {
      throw new Error(
        `Stigmergy needs at least 2 agents — emergence requires multiple participants. Only ${ready.length} spawned.`,
      );
    }
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. All agents are equal explorers — no planner, no roles.`,
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
    const seed = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      "Pattern: Stigmergy (pheromone trails). Agents pick which file to read each turn based on a shared annotation table. Untouched files attract; high-interest low-confidence files attract; well-covered files repel. The exploration is self-organizing — no central planner.",
    ].join("\n");
    this.appendSystem(seed, buildSeedSummary(cfg.repoUrl, clonePath, tree));
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
        if (this.stopping) break;
        const guard = checkBudgetGuards({
          tokenBaseline,
          tokenBudget: cfg.tokenBudget,
          round: r,
          totalRounds: cfg.rounds,
          unit: "round",
        });
        if (guard.halt) {
          this.earlyStopDetail = guard.earlyStopDetail;
          this.appendSystem(guard.message ?? "");
          break;
        }
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

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
  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
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
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return;
    if (this.stopping) return;
    const prompt = buildTerritoryPlanPrompt({
      directive: cfg.userDirective ?? "",
      candidatePaths,
      explorerCount: agents.length,
    });
    this.appendSystem(`[improvement #2] Lead agent (${lead.id}) drafting per-explorer territory assignments…`);
    const controller = new AbortController();
    let raw = "";
    try {
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = (await promptWithFailoverAuto(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        agentName: "swarm-read",
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: describeSdkError,
      })) as { data: { parts: Array<{ type: "text"; text: string }> } };
      raw = (res?.data?.parts?.find((p) => p.type === "text")?.text ?? "").trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[improvement #2] Lead's territory-plan prompt failed (${msg}); explorers will wander.`);
      return;
    }
    const parsed = parseTerritoryPlan(raw);
    if (!parsed) {
      this.appendSystem(`[improvement #2] Could not parse lead's territory plan; explorers will wander. Raw: ${raw.slice(0, 200)}`);
      return;
    }
    let assignedCount = 0;
    for (const [agentIndex, territory] of parsed.entries()) {
      if (territory && territory.trim().length > 0) {
        this.territoryAssignments.set(agentIndex, territory.trim());
        assignedCount += 1;
      }
    }
    this.appendSystem(`[improvement #2] Territory plan accepted: ${assignedCount}/${agents.length} explorers assigned a starting territory.`);
  }

  private async runReportOutPass(): Promise<void> {
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return;
    this.opts.manager.markStatus(lead.id, "thinking");
    this.emitAgentState({
      id: lead.id,
      index: lead.index,
      port: lead.port,
      sessionId: lead.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    this.stats.countTurn(lead.id);
    this.appendSystem(`Synthesizing stigmergy findings (agent-${lead.index})…`);

    // Server-side ranking — annotations sorted by rankingScore (visits ×
    // avgInterest × confidence × decay). Pre-2026-05-02 the formula
    // was just visits × avgInterest, which ignored confidence + treated
    // stale annotations as fresh. Top 10 surfaces the highest-signal
    // files; cap prevents prompt bloat on big repos.
    const ranked = [...this.annotations.entries()]
      .map(([file, a]) => ({ file, ...a, score: rankingScore(a, this.round) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    const tableText = ranked
      .map((r, i) => `${i + 1}. ${r.file} — visits=${r.visits}, interest=${r.avgInterest.toFixed(1)}, confidence=${r.avgConfidence.toFixed(1)}, score=${r.score.toFixed(1)}, note="${r.latestNote}"`)
      .join("\n");
    const prompt = [
      "You are Agent 1, the stigmergy synthesis lead. The swarm just finished exploring a repo with self-organizing file picks driven by a shared annotation table.",
      "Your job NOW is to produce a human-readable REPORT-OUT summarizing what the swarm found.",
      "",
      "STRUCTURE your response as:",
      "1. **Top findings** — 3-5 bullets naming the most interesting files and WHY (cite the agents' notes).",
      "2. **Coverage** — what was explored well, what was missed (any obvious gaps in the pheromone table?).",
      "3. **Recommended next action** — ONE concrete next step a developer should take based on what the swarm surfaced.",
      "",
      "Keep it under ~400 words. Be specific. Reference file paths. Don't just restate the table — interpret it.",
      "",
      "=== TOP 10 FILES BY (visits × interest) ===",
      tableText,
      "=== END TABLE ===",
      "",
      "Produce your report-out now.",
    ].join("\n");

    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = await promptWithFailoverAuto(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: describeSdkError,
        onTiming: ({ attempt, elapsedMs, success }) => {
          this.stats.onTiming(lead.id, success, elapsedMs);
          this.opts.manager.recordPromptComplete(lead.id, { attempt, elapsedMs, success });
          this.opts.emit({
            type: "agent_latency_sample",
            agentId: lead.id,
            agentIndex: lead.index,
            attempt,
            elapsedMs,
            success,
            ts: Date.now(),
          });
        },
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
          this.stats.onRetry(lead.id);
          this.appendSystem(
            `[${lead.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
          );
        },
      });
      const diagCtx = {
        runner: "stigmergy",
        agentId: lead.id,
        agentIndex: lead.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(lead, prompt, "swarm-read", diagCtx);
        if (retryText !== null) text = retryText;
      }
      // Task #115: track Pattern 8 stuck-loop, warn on threshold.
      trackPostRetryJunk(text, {
        agentId: lead.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      // Task #108: defensive guard — see CouncilRunner.runSynthesisPass.
      const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: lead.id,
        agentIndex: lead.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        summary: isJunkSynthesis
          ? undefined
          : { kind: "stigmergy_report", filesRanked: ranked.length },
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      if (isJunkSynthesis) {
        this.appendSystem(
          `[${lead.id}] stigmergy report-out text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical report.`,
        );
      }
    } catch (err) {
      this.appendSystem(
        `[${lead.id}] report-out failed (${err instanceof Error ? err.message : String(err)}); skipping synthesis.`,
      );
    } finally {
      watchdog.cancel();
      this.opts.manager.markStatus(lead.id, "ready");
      this.emitAgentState({
        id: lead.id,
        index: lead.index,
        port: lead.port,
        sessionId: lead.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
    }
  }

  private async runExplorerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    candidatePaths: readonly string[],
  ): Promise<void> {
    // 2026-05-02 (improvement #1): compute recently-active files from
    // the last 1-2 rounds for the per-agent prompt. Surfaces the
    // dynamic peer-activity signal above the cumulative table.
    const recentlyActive: { file: string; round: number; note: string }[] = [];
    if (round > 1) {
      for (const [file, state] of this.annotations) {
        if (state.lastVisitedRound !== undefined && state.lastVisitedRound >= round - 2 && state.lastVisitedRound < round) {
          recentlyActive.push({
            file,
            round: state.lastVisitedRound,
            note: state.latestNote,
          });
        }
      }
      // Cap at top 5 by visits to keep the prompt focused
      recentlyActive.sort((a, b) => {
        const stateA = this.annotations.get(a.file);
        const stateB = this.annotations.get(b.file);
        return (stateB?.visits ?? 0) - (stateA?.visits ?? 0);
      });
      recentlyActive.length = Math.min(recentlyActive.length, 5);
    }
    const prompt = buildExplorerPrompt({
      agentIndex: agent.index,
      round,
      totalRounds,
      candidatePaths,
      annotations: this.annotations,
      // 2026-05-02 (improvement #2): thread territory assignment from
      // the lead's pre-round-1 plan. Empty when plan failed.
      ...(this.territoryAssignments.has(agent.index)
        ? { territory: this.territoryAssignments.get(agent.index) }
        : {}),
      ...(recentlyActive.length > 0 ? { recentlyActive } : {}),
    });
    // #303: parse the annotation INSIDE the runAgent transform so
    // the JSON envelope gets stripped from visible bubble text + the
    // entry carries a structured stigmergy_annotation summary the UI
    // bubble can render as a card. Capture the parsed annotation here
    // for the applyAnnotation call below.
    let parsedAnn: ParsedAnnotation | null = null;
    const text = await this.runAgent(agent, prompt, {
      transformEntry: (entryText) => {
        parsedAnn = parseAnnotation(entryText);
        if (!parsedAnn) return { text: entryText };
        const cleanText = stripAnnotationEnvelope(entryText);
        return {
          text: cleanText.length > 0 ? cleanText : entryText,
          summary: {
            kind: "stigmergy_annotation",
            file: parsedAnn.file,
            interest: parsedAnn.interest,
            confidence: parsedAnn.confidence,
            note: parsedAnn.note,
          },
        };
      },
    });
    if (this.stopping || !text) return;
    if (parsedAnn) {
      const ann = parsedAnn as ParsedAnnotation;
      this.applyAnnotation(ann);
      this.appendSystem(
        `Annotation update — ${ann.file}: interest=${ann.interest}, confidence=${ann.confidence}, total visits=${this.annotations.get(ann.file)?.visits ?? 0}`,
      );
    } else {
      this.appendSystem(
        `[${agent.id}] no parseable annotation in response — agent's text kept in transcript but the pheromone table did not update for this turn.`,
      );
    }
  }

  private applyAnnotation(ann: ParsedAnnotation): void {
    const existing = this.annotations.get(ann.file);
    let next: AnnotationState;
    if (!existing) {
      next = {
        visits: 1,
        avgInterest: ann.interest,
        avgConfidence: ann.confidence,
        latestNote: ann.note,
        // 2026-05-02 (improvement #5): track round for decay scoring.
        lastVisitedRound: this.round,
      };
    } else {
      // Running average — equal weight per visit. Cheap, good enough for v1.
      const n = existing.visits + 1;
      next = {
        visits: n,
        avgInterest: (existing.avgInterest * existing.visits + ann.interest) / n,
        avgConfidence: (existing.avgConfidence * existing.visits + ann.confidence) / n,
        latestNote: ann.note,
        // 2026-05-02 (improvement #5): bump last-visited to current round.
        lastVisitedRound: this.round,
      };
    }
    this.annotations.set(ann.file, next);
    // Phase 2a: live WS update so the PheromonePanel reflects new
    // annotations immediately instead of waiting for catch-up. Single-
    // row updates (not the full table) keep the event small even when
    // the annotation set grows.
    this.opts.emit({
      type: "pheromone_updated",
      file: ann.file,
      state: { ...next },
    });
    // T197 (2026-05-04): cross-cluster discovery — spread pheromones
    // to related files via import graph when this annotation has
    // high interest (>= 7). Fire-and-forget so applyAnnotation stays
    // sync; Promise rejection swallowed.
    if (this.active?.crossClusterDiscovery && ann.interest >= 7) {
      void this.spreadCrossClusterPheromones(ann.file, ann.interest);
    }
  }

  // T197 (2026-05-04): plant soft pheromone bumps on files related to
  // the seedFile via the import graph. Bump = synthetic visit with
  // half the seed's interest + low confidence (signaling "peer found
  // something interesting in a related file"). Lazy-loads the import
  // graph on first call. Best-effort: build failure / no edges →
  // no-op.
  private async spreadCrossClusterPheromones(
    seedFile: string,
    seedInterest: number,
  ): Promise<void> {
    try {
      if (this.importGraphCache === null) {
        const clonePath = this.active?.localPath;
        if (!clonePath) return;
        const allFiles = await this.opts.repos.listRepoFiles(clonePath, {
          maxFiles: 500,
        });
        const tsJsFiles = allFiles.filter((f) =>
          /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f),
        );
        if (tsJsFiles.length === 0) {
          this.importGraphCache = new Map();
          return;
        }
        this.importGraphCache = await buildImportGraph(clonePath, tsJsFiles);
      }
      const related = relatedFilesViaImports(seedFile, this.importGraphCache, 5);
      if (related.length === 0) return;
      // Plant soft bumps — half-interest + low confidence so the
      // related file shows up as "worth a look" without overwhelming
      // a real annotation from a peer agent.
      const bumpInterest = Math.max(1, Math.round(seedInterest / 2));
      const bumpConfidence = 2;
      for (const relFile of related) {
        // Only bump files NOT already annotated — don't overwrite
        // peer annotations with synthetic bumps.
        if (this.annotations.has(relFile)) continue;
        this.applyAnnotation({
          file: relFile,
          interest: bumpInterest,
          confidence: bumpConfidence,
          note: `[cross-cluster bump from ${seedFile}] related via import graph`,
        });
      }
      this.appendSystem(
        `[T197 cross-cluster] seed ${seedFile} (interest=${seedInterest}) spread soft bumps to ${related.length} related file(s) via import graph.`,
      );
    } catch {
      // best-effort — graph-build failure shouldn't block the run
    }
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
        runner: "stigmergy",
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
      const strippedAgent = stripAgentText(text);
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

const SKIP_ENTRIES = new Set([".git/", ".git", "node_modules/", "node_modules", ".DS_Store"]);

export interface AnnotationState {
  visits: number;
  avgInterest: number;
  avgConfidence: number;
  latestNote: string;
  // 2026-05-02 (stigmergy improvement #5): round of last visit. Lets
  // the ranking formula apply pheromone decay — annotations from
  // earlier rounds with no follow-up fade vs files multiple explorers
  // revisited recently. Defaults to 1 for back-compat with pre-fix
  // states (e.g. recovered serialized annotations).
  lastVisitedRound?: number;
}

// 2026-05-02 (stigmergy improvement #5): per-round decay factor.
// Each unvisited round multiplies the score by this factor — after
// 3 rounds untouched, score drops to ~34%. Tuned conservatively;
// dramatic decay would surprise users. Pure constant — exported for
// tests so the calibration is locked.
export const PHEROMONE_DECAY_PER_ROUND = 0.7;

// 2026-05-02 (stigmergy improvement #4): confidence weighting in the
// ranking score. Pre-fix the formula was (visits × avgInterest);
// confidence was captured but ignored. New formula:
//   score = visits × avgInterest × (avgConfidence / 10) × decay
// Confidence scaled to [0, 1] so a high-interest-low-confidence file
// (interest=10, confidence=2) ranks below a slightly-less-interesting-
// but-solid one (interest=8, confidence=9). Pure — exported for tests.
export function rankingScore(
  state: AnnotationState,
  currentRound?: number,
): number {
  const baseScore = state.visits * state.avgInterest * (state.avgConfidence / 10);
  if (currentRound === undefined || state.lastVisitedRound === undefined) {
    return baseScore;
  }
  const roundsSince = Math.max(0, currentRound - state.lastVisitedRound);
  return baseScore * Math.pow(PHEROMONE_DECAY_PER_ROUND, roundsSince);
}

// T177 (2026-05-04): typed pheromones. Beyond the numeric interest +
// confidence, agents now tag annotations with a semantic kind so peer
// explorers + the final synthesis can read the pheromone trail with
// more nuance. Old annotations (no kind) still parse cleanly — kind
// is optional.
//
//   relevant       — file directly bears on the directive / project goal
//   dead-end       — file looks promising but doesn't help; don't burn turns here
//   needs-more-eyes — interesting but the agent's confidence is low; another agent should re-read
//   contradicts    — finding here disagrees with what another file/finding suggests
export type PheromoneKind = "relevant" | "dead-end" | "needs-more-eyes" | "contradicts";
export const PHEROMONE_KINDS: readonly PheromoneKind[] = [
  "relevant",
  "dead-end",
  "needs-more-eyes",
  "contradicts",
];

export interface ParsedAnnotation {
  file: string;
  interest: number;
  confidence: number;
  note: string;
  /** T177: optional semantic tag. Defaults to undefined for back-compat. */
  kind?: PheromoneKind;
}

// Exported for testability. Accepts JSON {file, interest, confidence, note}
// either as a raw object, fenced in markdown, or embedded in prose. Returns
// null if no usable annotation can be extracted; the caller treats this as
// "no pheromone update this turn" and just keeps the agent's text in the
// transcript. Lenient on integer-vs-float; clamps interest/confidence to
// [0, 10] so a confused model can't poison the table with extremes.
/** #303: strip the annotation JSON envelope from agent text so the
 *  visible bubble shows prose only. Removes (in order):
 *    1. ```json ... ``` fenced blocks
 *    2. ``` ... ``` (no language tag) blocks
 *    3. Trailing bare {...} blocks
 *  Trims trailing whitespace. Returns the cleaned text. Exported for
 *  tests. */
export function stripAnnotationEnvelope(text: string): string {
  let out = text;
  // Fenced JSON block (most common)
  out = out.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/i, "");
  // Bare trailing {...} block (less common but the model sometimes
  // skips the fences and just emits raw JSON at the end)
  out = out.replace(/\s*\{[\s\S]*?\}\s*$/, "");
  return out.trimEnd();
}

export function parseAnnotation(raw: string): ParsedAnnotation | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates = [fenceMatch ? fenceMatch[1] : null, raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const ann = tryParseObject(candidate);
    if (ann) return ann;
  }
  return null;
}

function tryParseObject(input: string): ParsedAnnotation | null {
  // Try direct JSON first
  try {
    const parsed = JSON.parse(input);
    const ann = coerceAnnotation(parsed);
    if (ann) return ann;
  } catch {
    // fall through to brace-finding
  }
  // Try the first {...} block
  const braceMatch = input.match(/\{[\s\S]*?\}/);
  if (!braceMatch) return null;
  try {
    const parsed = JSON.parse(braceMatch[0]);
    return coerceAnnotation(parsed);
  } catch {
    return null;
  }
}

function coerceAnnotation(parsed: unknown): ParsedAnnotation | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const file = typeof o.file === "string" ? o.file.trim() : null;
  const interestRaw = typeof o.interest === "number" ? o.interest : null;
  const confidenceRaw = typeof o.confidence === "number" ? o.confidence : null;
  const note = typeof o.note === "string" ? o.note.trim() : "";
  if (!file || interestRaw === null || confidenceRaw === null) return null;
  // Clamp [0, 10] so a model that emits 100 or -5 can't poison the table.
  const interest = Math.max(0, Math.min(10, interestRaw));
  const confidence = Math.max(0, Math.min(10, confidenceRaw));
  // T177: optional kind. Whitelist against the catalog so a model
  // emitting "kinda-relevant" or "?" doesn't get accepted.
  const kindRaw = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  const kind = (PHEROMONE_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as PheromoneKind)
    : undefined;
  return {
    file,
    interest,
    confidence,
    note,
    ...(kind ? { kind } : {}),
  };
}

interface BuildExplorerPromptArgs {
  agentIndex: number;
  round: number;
  totalRounds: number;
  candidatePaths: readonly string[];
  annotations: ReadonlyMap<string, AnnotationState>;
  // 2026-05-02 (improvement #2): per-explorer territory assignment from
  // the lead's pre-round-1 plan. Soft suggestion — the explorer can
  // still wander based on the pheromone trail. Empty/absent for
  // round 1 plan-failure cases or pre-fix runs.
  territory?: string;
  // 2026-05-02 (improvement #1): files annotated in the LAST 2 rounds
  // by other explorers. Surfaced as a separate "RECENTLY ACTIVE"
  // section so the dynamic peer-activity signal is visible above the
  // static cumulative table. Pre-fix the table mixed all rounds —
  // hard for the agent to tell what just changed. Empty/absent for
  // round 1 (no prior rounds yet).
  recentlyActive?: readonly { file: string; round: number; note: string }[];
}

export function buildExplorerPrompt(args: BuildExplorerPromptArgs): string {
  const { agentIndex, round, totalRounds, candidatePaths, annotations, territory, recentlyActive } = args;
  const tableText = formatAnnotations(annotations);
  const candidateText = candidatePaths.length > 0 ? candidatePaths.join(", ") : "(none — repo seems empty)";

  const parts: string[] = [
    `You are Agent ${agentIndex}, an explorer in a stigmergy swarm reviewing a cloned GitHub project.`,
    `This is round ${round}/${totalRounds}. The lead may have suggested a starting territory for you (see below); the pheromone trail is shared so every agent's exploration informs the next.`,
    "",
    "Your turn:",
    "1. Look at the annotation table. Untouched files are most attractive. Among visited files, prefer high INTEREST + low CONFIDENCE — those are interesting and not yet understood. Avoid files that are well-covered (multiple visits, high confidence).",
    "2. Pick ONE file or directory entry to inspect. Read it (or sample it if it's large) using the file-read tool. Be concrete about what you read.",
    "3. Output BOTH a short prose report (under 200 words) AND a final JSON annotation block on the last line.",
    "",
    "Annotation JSON shape (last line of your response, no markdown fences):",
    '{"file": "src/foo.ts", "interest": 0-10, "confidence": 0-10, "note": "one-line summary", "kind": "relevant"}',
    "",
    "Where:",
    "- `interest` = how much further investigation this file warrants (10 = very interesting / load-bearing / surprising; 0 = boring / trivial).",
    "- `confidence` = how well YOU understand it after this read (10 = fully understood; 0 = barely scratched the surface).",
    "- `note` = one-line summary that future agents can use as a pheromone signal.",
    // T177 (2026-05-04): typed pheromones. Optional — omit kind if
    // none clearly fits. Future explorers + the synthesis read kind
    // to make smarter next-file decisions instead of relying solely
    // on the numeric interest/confidence scores.
    '- `kind` (optional) = one of: "relevant" (directly bears on the directive), "dead-end" (looks promising but doesn\'t help — don\'t burn turns here), "needs-more-eyes" (interesting but your confidence is low; another agent should re-read), "contradicts" (your finding disagrees with another file\'s implication).',
    "",
    `Top-level candidates: ${candidateText}`,
  ];
  // 2026-05-02 (improvement #2): territory assignment from lead's plan.
  if (territory && territory.trim().length > 0) {
    parts.push("");
    parts.push(`=== YOUR ASSIGNED TERRITORY (lead's pre-round plan) ===`);
    parts.push(territory.trim());
    parts.push(`=== END TERRITORY ===`);
    parts.push(`This is a SUGGESTION — start here, but follow the pheromone trail if peers' annotations make a different file more interesting.`);
  }
  // 2026-05-02 (improvement #1): recent-activity highlight (round 2+).
  if (recentlyActive && recentlyActive.length > 0) {
    parts.push("");
    parts.push(`=== RECENTLY ACTIVE (peers' annotations from the last 1-2 rounds) ===`);
    for (const r of recentlyActive) {
      parts.push(`- ${r.file} (round ${r.round}): ${r.note}`);
    }
    parts.push(`=== END RECENT ===`);
    parts.push(`These files just got peer attention. Either VALIDATE/REFUTE the recent annotations OR seek UNEXPLORED ground — don't redundantly re-walk what was just covered.`);
  }
  parts.push("");
  parts.push("=== ANNOTATION TABLE (current, cumulative across all rounds) ===");
  parts.push(tableText);
  parts.push("=== END TABLE ===");
  parts.push("");
  parts.push(`Now respond as Agent ${agentIndex}. Remember: prose report THEN annotation JSON on the last line.`);
  return parts.join("\n");
}

// 2026-05-02 (improvement #2): pure prompt builder for the lead's
// pre-round-1 territory plan. Asks the lead to assign each explorer a
// starting territory based on the directive + repo top-level structure.
// Output is strict JSON: {"<agentIndex>": "<territory description>"}.
// Pure — exported for tests.
export function buildTerritoryPlanPrompt(input: {
  directive: string;
  candidatePaths: readonly string[];
  explorerCount: number;
}): string {
  const indices = Array.from({ length: input.explorerCount }, (_, i) => i + 1);
  return [
    "You are Agent 1, the lead explorer in a stigmergy swarm. Before round 1 starts, you're issuing per-explorer TERRITORY ASSIGNMENTS — a starting hint for each explorer based on the user's directive + the repo's top-level structure.",
    "",
    "GOAL: prevent accidental overlap. Without territory assignments, multiple explorers may walk the same area in parallel — wasted work. Your assignments give each explorer a focal point so they spread out naturally on round 1.",
    "",
    "Your assignment is a SUGGESTION. Explorers can wander based on the pheromone trail; you're seeding their starting point, not constraining them.",
    "",
    `USER DIRECTIVE: ${input.directive.trim() || "(no directive)"}`,
    `REPO TOP-LEVEL CANDIDATES: ${input.candidatePaths.length > 0 ? input.candidatePaths.join(", ") : "(empty)"}`,
    `EXPLORER COUNT: ${input.explorerCount} (you yourself are agent 1; assign all of them including yourself).`,
    "",
    "Output STRICT JSON only (no prose, no markdown fences). Shape:",
    `  {${indices.map((i) => `"${i}": "<short territory description for agent ${i}>"`).join(", ")}}`,
    "",
    "Rules:",
    "- One key per explorer index, all keys MUST be present.",
    "- Each value is 5-30 words: name a directory, file pattern, or theme.",
    "- Distribute coverage broadly — avoid sending two explorers to the same dir.",
    "- Anchor in the directive when relevant (e.g. directive about auth → assign someone to auth/).",
    "- For repos smaller than the explorer count, allow overlap with different angles (e.g. 'src/ — focus on tests' vs 'src/ — focus on entry points').",
    "",
    "Output JSON now:",
  ].join("\n");
}

/** Pure parser for the lead's territory plan response. Returns
 *  Map<agentIndex, territory> on success, null on parse failure.
 *  Best-effort — strips ```json fences, finds the first {} block.
 *  Exported for tests. */
export function parseTerritoryPlan(raw: string): Map<number, string> | null {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const idx = Number.parseInt(key, 10);
    if (!Number.isFinite(idx) || idx < 1) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    out.set(idx, value.trim());
  }
  if (out.size === 0) return null;
  return out;
}

// Phase B (Task #98): produce a stable signature of the current top-10
// ranking. Uses file names only — small score jitter shouldn't reset the
// stability window. A delimiter that can't appear in a path keeps the
// signature unambiguous.
//
// 2026-05-02 (improvements #4 + #5): now uses confidence-weighted +
// decay-aware rankingScore. currentRound is optional for back-compat
// with callers that don't have round context.
export function computeRankingSignature(
  annotations: ReadonlyMap<string, AnnotationState>,
  currentRound?: number,
): string {
  const ranked = [...annotations.entries()]
    .map(([file, a]) => ({ file, score: rankingScore(a, currentRound) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.file.localeCompare(b.file);
    })
    .slice(0, 10)
    .map((r) => r.file);
  return ranked.join("␟");
}

// T187 (2026-05-04): build the hot-files section that the T2.3 chain
// hint will extract a recommendation from. Picks top-K files by
// rankingScore, formats them as a clear next-action prose block so
// extractNextActions sees the structure. When pheromones are absent
// (degenerate run) returns a placeholder explaining that no chain
// target was identified.
export function buildHotFilesChainSection(
  annotations: ReadonlyMap<string, AnnotationState>,
  currentRound: number,
  topN: number = 3,
): string {
  if (annotations.size === 0) {
    return "_(no annotations captured — no chain target identified; the run produced no actionable file-level signal)_";
  }
  const ranked = [...annotations.entries()]
    .map(([file, a]) => ({ file, state: a, score: rankingScore(a, currentRound) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.file.localeCompare(b.file);
    })
    .slice(0, topN);
  if (ranked.length === 0) {
    return "_(ranking returned empty — no chain target identified)_";
  }
  const lines: string[] = [];
  lines.push(
    "These files accumulated the most pheromone signal during exploration. Recommended next blackboard run: target these files specifically as the directive.",
  );
  lines.push("");
  lines.push("**Top hot files (by pheromone score):**");
  for (const r of ranked) {
    lines.push(
      `- \`${r.file}\` — visits=${r.state.visits}, interest=${r.state.avgInterest.toFixed(1)}/10, confidence=${r.state.avgConfidence.toFixed(1)}/10, score=${r.score.toFixed(1)}. Latest note: "${r.state.latestNote}"`,
    );
  }
  lines.push("");
  lines.push("**Recommended chain action:**");
  const fileList = ranked.map((r) => r.file).join(", ");
  lines.push(
    `- Audit ${fileList} via blackboard preset; the stigmergy run flagged these as high-interest with mid-to-low confidence — they likely repay deeper investigation.`,
  );
  return lines.join("\n");
}

export function formatAnnotations(annotations: ReadonlyMap<string, AnnotationState>): string {
  if (annotations.size === 0) return "(empty — no files annotated yet; everything is untouched)";
  const rows: string[] = [];
  // Sort: most-visited first, then by file name for stability
  const entries = [...annotations.entries()].sort((a, b) => {
    if (b[1].visits !== a[1].visits) return b[1].visits - a[1].visits;
    return a[0].localeCompare(b[0]);
  });
  for (const [file, s] of entries) {
    rows.push(
      `${file} — visits=${s.visits} interest=${s.avgInterest.toFixed(1)} confidence=${s.avgConfidence.toFixed(1)} note="${s.latestNote}"`,
    );
  }
  return rows.join("\n");
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
