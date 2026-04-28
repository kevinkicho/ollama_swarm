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
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, buildRunFinishedSummary, buildSeedSummary, formatPortReleaseLine, formatRunFinishedBanner, writeRunSummary } from "./runSummary.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { shouldHaltOnQuota, snapshotLifetimeTokens, tokenBudgetExceeded, tokenTracker } from "../services/ollamaProxy.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { runEndReflection } from "./runEndReflection.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";

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

      // Task #124: snapshot lifetime tokens for budget delta.
      const tokenBaseline = snapshotLifetimeTokens();
      // Task #146: dead-loop guard (mirrors #144).
      let consecutiveEmptyRounds = 0;
      const EMPTY_ROUND_BREAK_THRESHOLD = 2;

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        // Task #124: token-budget cap check.
        if (tokenBudgetExceeded(tokenBaseline, cfg.tokenBudget)) {
          this.earlyStopDetail = `token-budget reached (${cfg.tokenBudget?.toLocaleString()} tokens)`;
          this.appendSystem(`Token budget of ${cfg.tokenBudget?.toLocaleString()} tokens reached at round ${r - 1}/${cfg.rounds} — ending run early.`);
          break;
        }
        // Task #137: quota-wall cap check.
        if (shouldHaltOnQuota()) {
          const q = tokenTracker.getQuotaState();
          this.earlyStopDetail = `ollama-quota-exhausted (${q?.statusCode}: ${q?.reason.slice(0, 100)})`;
          this.appendSystem(`Ollama quota wall hit at round ${r - 1}/${cfg.rounds} (${q?.statusCode}) — ending run early.`);
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
        if (!this.stopping) {
          const newEntries = this.transcript
            .slice(transcriptLenBefore)
            .filter((e) => e.role === "agent");
          const allEmpty = newEntries.length > 0 &&
            newEntries.every((e) => (e.text || "") === "(empty response)" || looksLikeJunk(e.text || ""));
          if (allEmpty) {
            consecutiveEmptyRounds++;
            if (consecutiveEmptyRounds >= EMPTY_ROUND_BREAK_THRESHOLD) {
              this.earlyStopDetail = `explorers-silenced (${consecutiveEmptyRounds} consecutive empty rounds)`;
              this.appendSystem(
                `All explorers produced empty/junk output for ${consecutiveEmptyRounds} consecutive rounds — ending stigmergy early.`,
              );
              break;
            }
          } else {
            consecutiveEmptyRounds = 0;
          }
        }

        // Phase B (Task #98): record this round's ranking, check for
        // stability. Run only when annotations exist (else the empty
        // signature trivially matches itself).
        if (!this.stopping && this.annotations.size > 0 && r < cfg.rounds) {
          const sig = computeRankingSignature(this.annotations);
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
      // Task #150: end-of-run reflection (lead explorer does it).
      if (!crashMessage && !this.stopping && cfg.runId) {
        const lead = this.opts.manager.list().find((a) => a.index === 1);
        if (lead) {
          const ctxSummary = `Stigmergy preset · ${cfg.agentCount} explorers · ran ${this.round}/${cfg.rounds} rounds${this.earlyStopDetail ? ` · early-stop: ${this.earlyStopDetail}` : ""}`;
          await runEndReflection({
            agent: lead, preset: cfg.preset, runId: cfg.runId, clonePath: cfg.localPath,
            contextSummary: ctxSummary, log: (msg) => this.appendSystem(msg),
          }).catch(() => {});
        }
      }
      await this.writeSummary(cfg, crashMessage);
      // Unit 55: auto-killAll on natural completion (see RoundRobinRunner).
      if (!this.stopping) {
        const killResult = await this.opts.manager.killAll();
        this.appendSystem(formatPortReleaseLine(killResult));
        this.setPhase("completed");
      }
    }
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
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
      this.appendSystem(
        formatRunFinishedBanner(summary),
        buildRunFinishedSummary(summary),
      );
      this.appendSystem(
        `Wrote run summary (stopReason=${summary.stopReason}, wallClockMs=${summary.wallClockMs}, files=${summary.filesChanged}).`,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write run summary (${msg})`);
    }
  }

  // Task #80: report-out pass at end of run. Routes through agent-1
  // with the ranked annotation table and asks for a top-N narrative.
  // Tagged with summary kind "stigmergy_report" so the modal renders
  // distinctively. Failure is non-fatal — the raw annotation table
  // already landed in transcript above.
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

    // Server-side ranking — annotations sorted by visits × avgInterest.
    // Top 10 surfaces the highest-signal files; cap prevents prompt
    // bloat on big repos.
    const ranked = [...this.annotations.entries()]
      .map(([file, a]) => ({ file, ...a, score: a.visits * a.avgInterest }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    const tableText = ranked
      .map((r, i) => `${i + 1}. ${r.file} — visits=${r.visits}, interest=${r.avgInterest.toFixed(1)}, confidence=${r.avgConfidence.toFixed(1)}, note="${r.latestNote}"`)
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
      abortSession: () => lead.client.session.abort({ path: { id: lead.sessionId } }).then(() => {}),
    });
    try {
      const res = await promptWithRetry(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
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
    const prompt = buildExplorerPrompt({
      agentIndex: agent.index,
      round,
      totalRounds,
      candidatePaths,
      annotations: this.annotations,
    });
    const text = await this.runAgent(agent, prompt);
    if (this.stopping || !text) return;
    const ann = parseAnnotation(text);
    if (ann) {
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
      };
    } else {
      // Running average — equal weight per visit. Cheap, good enough for v1.
      const n = existing.visits + 1;
      next = {
        visits: n,
        avgInterest: (existing.avgInterest * existing.visits + ann.interest) / n,
        avgConfidence: (existing.avgConfidence * existing.visits + ann.confidence) / n,
        latestNote: ann.note,
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
  }

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

    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: () => agent.client.session.abort({ path: { id: agent.sessionId } }).then(() => {}),
    });

    try {
      // Unit 16: shared retry wrapper.
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        // Unit 20: read-only tools for discussion presets.
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
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: strippedAgent.finalText || "(empty response)",
        ts: Date.now(),
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
}

export interface ParsedAnnotation {
  file: string;
  interest: number;
  confidence: number;
  note: string;
}

// Exported for testability. Accepts JSON {file, interest, confidence, note}
// either as a raw object, fenced in markdown, or embedded in prose. Returns
// null if no usable annotation can be extracted; the caller treats this as
// "no pheromone update this turn" and just keeps the agent's text in the
// transcript. Lenient on integer-vs-float; clamps interest/confidence to
// [0, 10] so a confused model can't poison the table with extremes.
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
  return { file, interest, confidence, note };
}

interface BuildExplorerPromptArgs {
  agentIndex: number;
  round: number;
  totalRounds: number;
  candidatePaths: readonly string[];
  annotations: ReadonlyMap<string, AnnotationState>;
}

export function buildExplorerPrompt(args: BuildExplorerPromptArgs): string {
  const { agentIndex, round, totalRounds, candidatePaths, annotations } = args;
  const tableText = formatAnnotations(annotations);
  const candidateText = candidatePaths.length > 0 ? candidatePaths.join(", ") : "(none — repo seems empty)";

  return [
    `You are Agent ${agentIndex}, an explorer in a stigmergy swarm reviewing a cloned GitHub project.`,
    `This is round ${round}/${totalRounds}. There is no planner and no role assignment — every agent picks its own next file based on the shared annotation table below.`,
    "",
    "Your turn:",
    "1. Look at the annotation table. Untouched files are most attractive. Among visited files, prefer high INTEREST + low CONFIDENCE — those are interesting and not yet understood. Avoid files that are well-covered (multiple visits, high confidence).",
    "2. Pick ONE file or directory entry to inspect. Read it (or sample it if it's large) using the file-read tool. Be concrete about what you read.",
    "3. Output BOTH a short prose report (under 200 words) AND a final JSON annotation block on the last line.",
    "",
    "Annotation JSON shape (last line of your response, no markdown fences):",
    '{"file": "src/foo.ts", "interest": 0-10, "confidence": 0-10, "note": "one-line summary"}',
    "",
    "Where:",
    "- `interest` = how much further investigation this file warrants (10 = very interesting / load-bearing / surprising; 0 = boring / trivial).",
    "- `confidence` = how well YOU understand it after this read (10 = fully understood; 0 = barely scratched the surface).",
    "- `note` = one-line summary that future agents can use as a pheromone signal.",
    "",
    `Top-level candidates: ${candidateText}`,
    "",
    "=== ANNOTATION TABLE (current) ===",
    tableText,
    "=== END TABLE ===",
    "",
    `Now respond as Agent ${agentIndex}. Remember: prose report THEN annotation JSON on the last line.`,
  ].join("\n");
}

// Phase B (Task #98): produce a stable signature of the current top-10
// ranking by (visits × avgInterest). Uses file names only — small score
// jitter shouldn't reset the stability window. A delimiter that can't
// appear in a path keeps the signature unambiguous.
export function computeRankingSignature(
  annotations: ReadonlyMap<string, AnnotationState>,
): string {
  const ranked = [...annotations.entries()]
    .map(([file, a]) => ({ file, score: a.visits * a.avgInterest }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.file.localeCompare(b.file);
    })
    .slice(0, 10)
    .map((r) => r.file);
  return ranked.join("␟");
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
