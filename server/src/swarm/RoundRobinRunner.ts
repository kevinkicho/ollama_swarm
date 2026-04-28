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
import { roleForAgent, type SwarmRole } from "./roles.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, buildRunFinishedSummary, buildSeedSummary, formatPortReleaseLine, formatRunFinishedBanner, writeRunSummary } from "./runSummary.js";
import { extractResponseBreakdown, extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { shouldHaltOnQuota, snapshotLifetimeTokens, tokenBudgetExceeded, tokenTracker } from "../services/ollamaProxy.js";
import { runEndReflection } from "./runEndReflection.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";

export interface RoundRobinOptions {
  // Unit 8: when set, every agent gets a per-index role prepended to its
  // prompt. The Orchestrator's "role-diff" preset instantiates this runner
  // with DEFAULT_ROLES; the plain "round-robin" preset leaves it undefined.
  roles?: readonly SwarmRole[];
}

// The current collaboration pattern: N identical agents take turns in a fixed
// order, each one seeing the full transcript before speaking. Discussion-only —
// agents may read files but don't edit them.
export class RoundRobinRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private readonly roles?: readonly SwarmRole[];
  // Unit 33: cross-preset metrics. Collector aggregates per-agent
  // counters (turns, attempts, retries, latencies) via the same
  // onTiming/onRetry hooks promptWithRetry already surfaces. startedAt
  // is stamped once the discussing loop begins so wall-clock excludes
  // clone + spawn (mirrors BlackboardRunner.runStartedAt scoping).
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase B (Task #100): set when the role-diff midpoint synthesis
  // returns CONVERGENCE: high. Promoted to stopReason="early-stop"
  // by writeSummary. Plain round-robin (no roles) never sets this.
  private earlyStopDetail?: string;

  constructor(private readonly opts: RunnerOpts, options?: RoundRobinOptions) {
    this.roles = options?.roles && options.roles.length > 0 ? options.roles : undefined;
  }

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
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.earlyStopDetail = undefined;
    this.summaryWritten = false;

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
    // Unit 48: hide runner-written artifacts from `git status` via the
    // clone's local .git/info/exclude (NOT the user's .gitignore).
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnStart = Date.now();
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length === 0) throw new Error("No agents started successfully");
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: "round-robin",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: () => "Discussant",
      }),
    );
    // Unit 33: register the spawned roster so buildPerAgentStats still
    // produces rows after AgentManager.killAll() clears its own roster.
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg);
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
      "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
    ].join("\n");
    this.appendSystem(seed, buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      // Phase B (Task #100): role-diff midpoint convergence check.
      // Only fires when the runner is in role-diff mode (this.roles
      // defined). Same midpoint pattern as council #99 — one extra
      // agent-1 call max, not per-round.
      const earlyCheckRound =
        this.roles && cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;

      // Task #124: snapshot lifetime tokens at run start for budget delta.
      const tokenBaseline = snapshotLifetimeTokens();

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        // Task #124: token-budget cap check before each round.
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

        const agents = this.opts.manager.list();
        for (const agent of agents) {
          if (this.stopping) break;
          await this.runTurn(agent, r, cfg.rounds);
        }

        // Phase B (Task #100): midpoint synthesis check for role-diff.
        // If convergence:high, the synthesis IS the canonical output
        // (we skip the post-loop pass, same as #99 council).
        if (
          this.roles &&
          !this.stopping &&
          r === earlyCheckRound &&
          r < cfg.rounds
        ) {
          const convergence = await this.runRoleDiffSynthesisPass(cfg);
          if (convergence === "high") {
            this.earlyStopDetail =
              `role-diff-converged-high after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `Role-diff reached convergence:high at round ${r}/${cfg.rounds} — ending early.`,
            );
            break;
          }
        }
      }

      // Phase B (Task #100): final synthesis pass (role-diff only).
      // Closes the gap noted in the tour summary — role-diff was the
      // only read-only preset without a synthesis tag. Skip if the
      // midpoint already broke us out (we already wrote one).
      if (this.roles && !this.stopping && cfg.rounds > 0 && !this.earlyStopDetail) {
        await this.runRoleDiffSynthesisPass(cfg);
      }

      if (!this.stopping) this.appendSystem("Discussion complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // Task #150: end-of-run reflection (cross-preset memory write).
      if (!crashMessage && !this.stopping && cfg.runId) {
        const lead = this.opts.manager.list().find((a) => a.index === 1);
        if (lead) {
          const ctxSummary = `${cfg.preset} preset · ${cfg.agentCount} agents · ran ${this.round}/${cfg.rounds} rounds${this.earlyStopDetail ? ` · early-stop: ${this.earlyStopDetail}` : ""}`;
          await runEndReflection({
            agent: lead, preset: cfg.preset, runId: cfg.runId, clonePath: cfg.localPath,
            contextSummary: ctxSummary, log: (msg) => this.appendSystem(msg),
          }).catch(() => {});
        }
      }
      // Unit 33: write summary.json at termination so any preset run
      // can be compared via scripts/compare-runs.mjs. Write BEFORE the
      // terminal setPhase so a UI observer reacting to "completed" can
      // trust the file is already on disk.
      await this.writeSummary(cfg, crashMessage);
      // Unit 55: auto-killAll on natural completion. Without this,
      // a finished run leaves agents holding ports + cloud sessions.
      // Skip when this.stopping=true — stop() already did the kill.
      if (!this.stopping) {
        const killResult = await this.opts.manager.killAll();
        this.appendSystem(formatPortReleaseLine(killResult));
        this.setPhase("completed");
      }
    }
  }

  // Unit 33: shared summary writer. Called once from the loop's finally
  // regardless of termination cause (completed / user-stop / crash).
  // summaryWritten guards against a double-write if stop() races the
  // natural completion path.
  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return; // never reached discussing
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(cfg.localPath);
    } catch {
      // gitStatus already swallows; extra belt.
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
      // Phase 4a of #243: topology passthrough.
      topology: cfg.topology,
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

  private async runTurn(agent: Agent, round: number, totalRounds: number): Promise<void> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "thinking", thinkingSince: Date.now() });
    // Unit 33: one turn = one call to runTurn (retries inside
    // promptWithRetry don't bump this; onTiming counts those separately).
    this.stats.countTurn(agent.id);

    const prompt = this.buildPrompt(agent, round, totalRounds);
    // 2026-04-27: SSE-aware watchdog. Replaces the wall-clock 4-min cap
    // that killed prompts the model was actively producing. The old
    // comment claimed "OpenCode's SSE stays completely silent" — that
    // was true before the #170 SSE auth fix; SSE chunks now flow
    // reliably and AgentManager.getLastActivity tracks them. See
    // sseAwareTurnWatchdog.
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: () => agent.client.session.abort({ sessionID: agent.sessionId }).then(() => {}),
    });

    try {
      // Unit 16: shared retry wrapper. Same retry semantics as
      // BlackboardRunner — UND_ERR_HEADERS_TIMEOUT and friends get up
      // to 3 attempts with [4s, 16s] backoff before giving up.
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        // Unit 20: read-only tools (file-read / grep / glob / list).
        // Discussion-only presets — never edits.
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: (e) => describeSdkError(e),
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
            // Task #104: prompt-size to correlate with elapsedMs.
            promptChars: prompt.length,
            round,
          });
          // Improvement #4: per-agent first-prompt cold-start logging.
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          // Unit 40: live-stream latency samples over WS so the UI can
          // render a sparkline tooltip on the thinking ticker.
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
        runner: "round-robin",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      // Task #117: response-side breakdown for latency RCA. Logged
      // per-turn so analysis can correlate (agentIndex, round) with
      // the same-key _prompt_timing record. Captures FIRST attempt's
      // breakdown — retries are visible separately via the timing log.
      const breakdown = extractResponseBreakdown(res);
      this.opts.logDiag?.({
        type: "_response_breakdown",
        preset: this.active?.preset,
        agentId: agent.id,
        agentIndex: agent.index,
        round,
        ...breakdown,
      });
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
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
      this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "ready", lastMessageAt: entry.ts });
    } catch (err) {
      const msg = watchdog.getAbortReason() ?? describeSdkError(err);
      this.appendSystem(`[${agent.id}] error: ${msg}`);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "failed", error: msg });
    } finally {
      watchdog.cancel();
    }
  }

  // Phase B (Task #100): role-diff synthesis pass. Mirrors the
  // council #79 pattern — agent-1 takes every role's findings and
  // produces a cross-role consolidation. Same prompt also asks for
  // a CONVERGENCE: high|medium|low signal (parsed for the early-stop
  // detector). Tagged "role_diff_synthesis" so the modal can render
  // it distinctively.
  private async runRoleDiffSynthesisPass(
    cfg: RunConfig,
  ): Promise<"high" | "medium" | "low" | null> {
    if (!this.roles) return null;
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return null;
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
    this.appendSystem(`Synthesizing role-diff findings (agent-${lead.index})…`);

    const prompt = buildRoleDiffSynthesisPrompt(this.roles, this.transcript);
    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: () => lead.client.session.abort({ sessionID: lead.sessionId }).then(() => {}),
    });
    try {
      const res = await promptWithRetry(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: (e) => describeSdkError(e),
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
        runner: "role-diff",
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
      const strippedSyn = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: lead.id,
        agentIndex: lead.index,
        text: strippedSyn.finalText || "(empty response)",
        ts: Date.now(),
        summary: isJunkSynthesis
          ? undefined
          : { kind: "role_diff_synthesis", rounds: cfg.rounds, roles: this.roles.length },
        ...(strippedSyn.thoughts.length > 0 ? { thoughts: strippedSyn.thoughts } : {}),
        ...(strippedSyn.toolCalls.length > 0 ? { toolCalls: strippedSyn.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      if (isJunkSynthesis) {
        this.appendSystem(
          `[${lead.id}] role-diff synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
        );
        return null;
      }
      return parseRoleDiffConvergence(text);
    } catch (err) {
      this.appendSystem(
        `[${lead.id}] role-diff synthesis failed (${err instanceof Error ? err.message : String(err)}); skipping consolidation.`,
      );
      return null;
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

  private buildPrompt(agent: Agent, round: number, totalRounds: number): string {
    const transcriptText = this.transcript
      .map((e) => {
        if (e.role === "system") return `[SYSTEM] ${e.text}`;
        if (e.role === "user") return `[HUMAN] ${e.text}`;
        const label = this.roles
          ? `Agent ${e.agentIndex} (${roleForAgent(e.agentIndex ?? 1, this.roles).name})`
          : `Agent ${e.agentIndex}`;
        return `[${label}] ${e.text}`;
      })
      .join("\n\n");

    const role = this.roles ? roleForAgent(agent.index, this.roles) : null;
    const header = role
      ? `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project. Your role is "${role.name}".`
      : `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project.`;
    const roleGuidance = role ? [`As the ${role.name}: ${role.guidance}`, ""] : [];

    return [
      header,
      `This is discussion round ${round} of ${totalRounds}.`,
      ...roleGuidance,
      "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
      // Task #118: hard tool-use requirement. Run daf5c92e showed
      // role-diff agents NEVER invoked file-read tools (0 tool calls
      // across 8 turns) — they were guessing from filenames in the
      // seed snapshot. Without file grounding, role-diff degenerates
      // to filename-trivia. The "REQUIRED" framing mirrors the OW
      // lead-grounding rule (#83) that fixed the same problem there.
      "REQUIRED — BEFORE writing your prose response:",
      "  1. Use the `read` tool on AT LEAST ONE file from the repo. Pick a file relevant to your role (e.g. Architect → README.md or main entry point; Tester → a test file; Security → auth/config; Performance → hot-path code).",
      "  2. If a peer in the transcript cited a specific file path you haven't seen, read THAT file before agreeing or pushing back.",
      "  3. If your prior turn made a claim about file contents, re-verify with a tool call before defending or revising the claim.",
      "Failing to make at least one tool call means your turn is uninformed and will be flagged as such by reviewers.",
      "",
      "Round 1: skim README.md and the top-level tree before opining. Later rounds: read the specific files needed to verify peer claims.",
      "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
      "You may @mention another agent (e.g. @Agent2) to address them directly.",
      "",
      "Goals of this discussion:",
      "1. Figure out what this project is and who it is for.",
      "2. Identify what is working and what is missing.",
      "3. Propose one concrete next action the swarm should take.",
      "",
      "=== SHARED TRANSCRIPT ===",
      transcriptText || "(empty — you are first to speak)",
      "=== END TRANSCRIPT ===",
      "",
      role
        ? `Now respond as Agent ${agent.index} (${role.name}), through the lens of your role. Tool-call first, then prose.`
        : `Now respond as Agent ${agent.index}. Tool-call first, then prose.`,
    ].join("\n");
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

// Phase B (Task #100): role-diff synthesis prompt. Same shape as
// the council synthesis (#79) — labeled cross-role table, not a
// re-summary of each agent's draft. The CONVERGENCE: line at the
// end is the early-stop signal (same parser pattern as council #99).
export function buildRoleDiffSynthesisPrompt(
  roles: readonly SwarmRole[],
  transcript: readonly TranscriptEntry[],
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const role =
        e.agentIndex !== undefined ? roleForAgent(e.agentIndex, roles) : null;
      const label = role
        ? `Agent ${e.agentIndex} (${role.name})`
        : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");
  const roleNames = roles.map((r) => r.name).join(", ");

  return [
    `You are Agent 1, the role-diff synthesis lead. The swarm just finished N rounds of discussion with agents wearing different roles: ${roleNames}.`,
    "Your job NOW is to produce a SINGLE consolidated cross-role view that integrates every role's findings.",
    "",
    "STRUCTURE your response as:",
    "1. **Cross-role agreement** — what every role independently flagged. State as direct claims, cite which role surfaced each (e.g. \"Architect + Tester both noted the absence of integration tests in src/api/\").",
    "2. **Role-specific findings** — one short bullet per role naming its single most important standalone observation that the others didn't make.",
    "3. **Disagreements / tensions** — places where role perspectives pull in different directions (e.g. Performance wants caching; Security flags it as a stale-data risk).",
    "4. **Next action** — ONE concrete next step grounded in the cross-role view.",
    "",
    "Keep it under ~400 words. Cite file paths from the discussion. Do NOT just restate each role's draft — synthesize across them.",
    "",
    // Phase B (Task #100): convergence signal — same line shape as
    // CouncilRunner so any UI/parser pattern transfers.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — roles largely agree; further rounds would only restate the cross-role view.",
    "  CONVERGENCE: medium — partial cross-role agreement with real open tensions still in play.",
    "  CONVERGENCE: low    — roles still pulling in different directions; more rounds would help.",
    "",
    "=== FULL ROLE-DIFF TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

// Phase B (Task #100): scan a synthesis response for the
// "CONVERGENCE: high|medium|low" line. Mirrors parseCouncilConvergence
// in CouncilRunner.ts.
export function parseRoleDiffConvergence(
  text: string,
): "high" | "medium" | "low" | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-3);
  for (const line of tail) {
    const m = /^convergence\s*:\s*(high|medium|low)\b/i.exec(line);
    if (m) return m[1].toLowerCase() as "high" | "medium" | "low";
  }
  return null;
}
