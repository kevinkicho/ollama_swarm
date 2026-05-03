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
import { formatChatReceipt } from "./chatReceipt.js";
import { detectSemanticConvergence } from "./semanticConvergence.js";
import { detectConvergence as detectJaccardConvergence } from "./moaConsensus.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractResponseBreakdown, extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { writeDeliverableAndEmit } from "./deliverable.js";
import { buildRoleDiffDeliverableSections } from "./roleDiffDeliverable.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickDeliverableTitle,
  pickDeliverableSubtitle,
} from "./directivePromptHelpers.js";
import {
  parseConvergenceSignal,
  parseConvergenceSignalLoose,
} from "./convergenceSignal.js";

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
  // by writeSummary. 2026-05-02: also set when plain round-robin's
  // structured-deliberation convergence check (improvement #3) detects
  // the discussion has settled.
  private earlyStopDetail?: string;
  // 2026-05-02 (round-robin improvement #1): cumulative turn counter
  // across all agents + rounds. Drives disposition rotation in
  // buildPrompt. Pre-incremented by runTurn before each prompt build.
  private turnsTaken = 0;

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
    // 2026-05-02 (improvement #5): user directive is now honored. When
    // present, surfaced at the TOP of the seed so every agent sees it
    // before any tool call. Round-robin moves out of "analysis-only"
    // status — the deliberation now drives toward a stated objective,
    // not just open-ended commentary on the repo.
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "The deliberation should converge on a concrete plan / answer for the directive above. Treat it as the question every disposition is helping resolve.",
        ],
      }),
      "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
    ];
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
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

      // 2026-05-03 (Phase B): budget + quota guards extracted to shared helper.
      const tokenBaseline = snapshotLifetimeTokens();

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
        // 2026-05-02 (round-robin improvement #3): semantic convergence
        // check for the no-roles structured-deliberation case. After
        // round 2+, if the LAST agent's turn this round is >0.85
        // cosine-similar to the same agent's turn LAST round, the
        // discussion has settled — stop early. Falls back to Jaccard
        // when embedding model unavailable. Saves the wasted "everyone
        // agreed already" tail.
        if (
          !this.roles &&
          !this.stopping &&
          r >= 2 &&
          r < cfg.rounds
        ) {
          const converged = await this.checkStructuredConvergence();
          if (converged) {
            this.earlyStopDetail = `structured-deliberation-converged after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `[improvement #3] Structured deliberation converged at round ${r}/${cfg.rounds} — last agent's turn echoes their prior round. Ending early.`,
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
      // 2026-05-02 (round-robin improvement #4): final synthesis pass
      // for the no-roles structured-deliberation case. Lead distills
      // Consensus / Disagreements / Recommended next step. Skip when
      // role-diff already ran or convergence cap broke us out.
      if (!this.roles && !this.stopping && cfg.rounds > 0 && !this.earlyStopDetail) {
        await this.runStructuredSynthesisPass(cfg);
      }

      // 2026-05-02 (role-diff improvement #4): portable deliverable for
      // role-diff. Pulls each role's latest `### MY DELIVERABLE` block
      // + the synthesis text into a PR-shaped markdown file. Fires for
      // every role-diff run that wasn't user-stopped or crashed,
      // including early-stop convergence runs (the synthesis already
      // wrote — we just compose around it). Best-effort; failure
      // doesn't block the rest of the close-out.
      if (this.roles && !this.stopping && cfg.runId) {
        try {
          const sections = buildRoleDiffDeliverableSections({
            userDirective: cfg.userDirective,
            roles: this.roles,
            agentCount: cfg.agentCount,
            transcript: this.transcript,
          });
          // 2026-05-03 (Phase A): directive helpers extracted to shared module.
          const dirCtx = readDirective(cfg);
          const subtitleBase = dirCtx.hasDirective
            ? `${cfg.agentCount} specialists across ${this.round}/${cfg.rounds} rounds`
            : `${cfg.agentCount} reviewers across ${this.round}/${cfg.rounds} rounds — open repo analysis`;
          writeDeliverableAndEmit(
            {
              preset: "role-diff",
              runId: cfg.runId,
              clonePath: cfg.localPath,
              title: pickDeliverableTitle(dirCtx, {
                withDirective: "Role-diff specialist deliverable",
                withoutDirective: "Role-diff repo audit",
              }),
              subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
              sections,
            },
            { transcript: this.transcript, emit: this.opts.emit },
          );
        } catch (err) {
          this.appendSystem(
            `[role-diff #4] Deliverable write failed (${err instanceof Error ? err.message : String(err)}); transcript still has the synthesis bubble.`,
          );
        }
      }

      if (!this.stopping) this.appendSystem("Discussion complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // RoundRobin's role-diff path's deliverable was already written
      // earlier in the try-block (gated on this.roles + runId), so the
      // helper here just handles reflection + summary + killAll + setPhase.
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
            `${cfg.preset} preset · ${cfg.agentCount} agents · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
      });
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

  private async runTurn(agent: Agent, round: number, totalRounds: number): Promise<void> {
    this.turnsTaken += 1; // 2026-05-02 (improvement #1): drive disposition rotation
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
      abortSession: async () => {},
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
  // 2026-05-02 (round-robin improvement #3): semantic convergence
  // check. Compares the LAST agent's turn this round to the SAME
  // agent's turn last round. When >0.85 cosine similar (or 0.7 Jaccard
  // when embedding unavailable), the discussion has settled. Pure
  // server-side check — no LLM call required (just an embed call when
  // semantic path fires). Best-effort: returns false on any failure
  // so the loop continues.
  private async checkStructuredConvergence(): Promise<boolean> {
    const agents = this.opts.manager.list();
    if (agents.length === 0) return false;
    // The last agent's turn this round vs last round.
    const agentEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex === agents[agents.length - 1].index,
    );
    if (agentEntries.length < 2) return false;
    const current = agentEntries[agentEntries.length - 1].text;
    const prior = agentEntries[agentEntries.length - 2].text;
    if (!current || !prior) return false;
    const ollamaBaseUrl = this.opts.ollamaBaseUrl;
    if (ollamaBaseUrl) {
      const semantic = await detectSemanticConvergence({
        prior,
        current,
        ollamaBaseUrl,
        threshold: 0.85,
      });
      if (semantic !== null) {
        this.appendSystem(
          `[improvement #3] Convergence check: embedding cosine=${semantic.similarity.toFixed(3)} (threshold ${semantic.threshold.toFixed(3)})`,
        );
        return semantic.converged;
      }
    }
    // Fallback: Jaccard when embedding model unavailable
    const verdict = detectJaccardConvergence(prior, current, 0.7);
    this.appendSystem(
      `[improvement #3] Convergence check (Jaccard fallback): jaccard=${verdict.similarity.toFixed(3)} (threshold ${verdict.threshold})`,
    );
    return verdict.converged;
  }

  // 2026-05-02 (round-robin improvement #4): final synthesis pass for
  // the no-roles structured-deliberation case. Mirrors the role-diff
  // version but uses buildStructuredSynthesisPrompt + tags as
  // role_diff_synthesis (existing summary kind — UI rendering applies
  // identically; could add a dedicated kind in a follow-up).
  private async runStructuredSynthesisPass(
    cfg: RunConfig,
  ): Promise<"high" | "medium" | "low" | null> {
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return null;
    if (this.stopping) return null;
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
    this.appendSystem(`[improvement #4] Synthesizing structured deliberation (agent-${lead.index})…`);
    const prompt = buildStructuredSynthesisPrompt(cfg.rounds, this.transcript, cfg.userDirective);
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      const res = (await promptWithRetry(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: (e) => describeSdkError(e),
      })) as { data: { parts: Array<{ type: "text"; text: string }> } };
      const text = (res?.data?.parts?.find((p) => p.type === "text")?.text ?? "").trim();
      if (text.length === 0) {
        this.appendSystem(`[improvement #4] Synthesis returned empty response; skipping.`);
        return null;
      }
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: lead.id,
        agentIndex: lead.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        // Tag with the existing role_diff_synthesis kind so the UI
        // renders distinctively. role_diff_synthesis was the natural
        // home; the disposition rotation is the structured-deliberation
        // analog of role-diff's specialized roles. Could add a
        // dedicated kind later.
        summary: { kind: "role_diff_synthesis", rounds: cfg.rounds, roles: 0 },
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      // 2026-05-03 (Phase A): convergence parser unified to shared module.
      // The synthesis-pass path historically used a looser scanner (anywhere
      // in text, not just trailing lines) so we keep that behavior here via
      // parseConvergenceSignalLoose. The role-diff path below uses the strict
      // trailing-3-lines parser via parseConvergenceSignal.
      return parseConvergenceSignalLoose(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[improvement #4] Synthesis prompt failed (${msg})`);
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
      });
    }
  }

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
      abortSession: async () => {},
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
      return parseConvergenceSignal(text);
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
    // 2026-05-02 (round-robin improvement #1): rotating dispositions
    // when NO roles configured. Lifts plain round-robin out of "neutral
    // baseline" by assigning each turn a deliberate LENS — critic /
    // synthesizer / gap-finder / builder. Forces value-add per turn:
    // no two consecutive turns can be the same character. Skipped when
    // role-diff is active (roles ARE the specialization).
    const turnNumber = this.turnsTaken; // pre-increment in caller
    const disposition = !this.roles ? getDispositionForTurn(turnNumber) : null;
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
      : disposition
        ? `You are Agent ${agent.index} in a structured deliberation. This turn, you take the **${disposition.name}** disposition.`
        : `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project.`;
    const roleGuidance = role ? [`As the ${role.name}: ${role.guidance}`, ""] : [];
    // 2026-05-02 (improvement #5): user directive injected into every
    // turn. Placed BEFORE the disposition block so each disposition
    // is explicitly applied to the directive (Critic critiques peers'
    // take on it, Builder proposes a next step toward it, etc.).
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective({ userDirective: this.active?.userDirective });
    const directiveBlock = buildDirectiveBlock(dirCtx, {
      labelSuffix: "(the question this deliberation must resolve)",
    });
    const directive = dirCtx.directive;
    // 2026-05-02 (improvement #1 + #2): disposition framing + active-
    // disagreement backbone. Both omitted when role-diff is active
    // (roles ARE the specialization).
    const dispositionBlock = disposition
      ? [
          `**${disposition.name.toUpperCase()} disposition this turn:** ${disposition.framing}`,
          "",
          "**ACTIVE-DISAGREEMENT RULE (every turn):** You MUST do at least ONE of: (a) challenge a specific prior point with reasoning, (b) add a NEW dimension peers haven't named, or (c) call out a real tradeoff being glossed. Never just agree or restate. If you have nothing to push on, say so explicitly + name what's still unclear.",
          "",
        ]
      : [];

    // 2026-05-02 (role-diff improvement #3): per-role concrete-deliverable
    // contract. Every role MUST end its turn with a `### MY DELIVERABLE`
    // block — not commentary, but the role's piece of the actual answer.
    // Implementer lists file changes; Tester lists assertions; etc.
    // The deliverable artifact (#4) extracts these blocks per-role to
    // assemble a portable PR-shaped doc. Without this contract role-diff
    // produces 7 commentaries; with it, 7 specialists each own one piece
    // of one answer.
    const deliverableBlock = role
      ? [
          "**MY DELIVERABLE CONTRACT (every turn, role-diff):** End your prose with a `### MY DELIVERABLE` heading followed by your role's concrete contribution.",
          role.deliverableHint
            ? `For your role (${role.name}): ${role.deliverableHint}`
            : `For your role (${role.name}): a concrete contribution toward the directive — not commentary on it.`,
          "Even if your role's piece doesn't change this round, write what your CURRENT best answer is — peers and the synthesis lead read this block, not your prose.",
          "",
        ]
      : [];

    return [
      header,
      `This is discussion round ${round} of ${totalRounds}. (Total turns so far: ${turnNumber}.)`,
      ...roleGuidance,
      ...directiveBlock,
      ...dispositionBlock,
      ...deliverableBlock,
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
      ...(directive.length > 0
        ? role
          ? [
              "Goals of this deliberation:",
              "1. Read the repo just enough to ground your role's deliverable in real code (not filename guesses).",
              `2. Through your role (${role.name}), produce YOUR specialist piece of the directive's answer. Other roles handle the other pieces — focus on yours.`,
              "3. By the final round the team should have converged on a coherent answer to the directive built from each role's deliverable, with the synthesis lead consolidating.",
              "",
            ]
          : [
              "Goals of this deliberation:",
              "1. Read the repo just enough to ground your take on the directive in real code (not filename guesses).",
              "2. Through your assigned disposition, advance the team's answer to the directive — challenge a peer's framing of it, surface what they're missing about it, or propose a concrete step toward it.",
              "3. By the final round the team should have converged on: a clear plan for the directive, what's risky about it, and what the next concrete step is.",
              "",
            ]
        : [
            "Goals of this discussion:",
            "1. Figure out what this project is and who it is for.",
            "2. Identify what is working and what is missing.",
            "3. Propose one concrete next action the swarm should take.",
            "",
          ]),
      "=== SHARED TRANSCRIPT ===",
      transcriptText || "(empty — you are first to speak)",
      "=== END TRANSCRIPT ===",
      "",
      role
        ? `Now respond as Agent ${agent.index} (${role.name}), through the lens of your role. Tool-call first, then prose, then your \`### MY DELIVERABLE\` block.`
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
// 2026-05-02 (round-robin improvement #1): rotating dispositions for
// the structured deliberation framework. When NO roles are configured,
// each turn cycles through these four lenses — every turn deliberately
// adds a distinct kind of value, no two consecutive turns can be the
// same character.
//
// Calibrated to a small fixed set: 4 dispositions covers the most
// useful axes of deliberation (push back / consolidate / surface gaps /
// move forward). More dispositions would dilute; fewer wouldn't cycle
// before agents repeat themselves.
export interface RoundRobinDisposition {
  name: string;
  framing: string;
}

export const DISPOSITIONS: readonly RoundRobinDisposition[] = [
  {
    name: "Critic",
    framing:
      "Find weaknesses in what's been said. Cite the specific claim you're challenging + your reason. Don't be contrary for its own sake — name the gap or unfounded assumption.",
  },
  {
    name: "Synthesizer",
    framing:
      "Distill what peers AGREED on (consensus) and what they DISAGREED on (open tradeoffs). Cite who said what. Surface 1-2 sentences that capture the current state of the discussion.",
  },
  {
    name: "Gap-finder",
    framing:
      "Name what HASN'T been addressed yet. What did the directive ask for that no peer has touched? What perspective (security, performance, ergonomics, cost) is missing? Cite specifics, not generalities.",
  },
  {
    name: "Builder",
    framing:
      "Propose ONE concrete next action the team should take. Name files to touch, decisions to make, or experiments to run. Be specific enough that a peer could execute on it. Build on what's been said; don't restart.",
  },
];

/** Pure helper — get the disposition for a 1-indexed turn number.
 *  Cycles through DISPOSITIONS in order. Pure — exported for tests. */
export function getDispositionForTurn(turnNumber: number): RoundRobinDisposition {
  const idx = ((turnNumber - 1) % DISPOSITIONS.length + DISPOSITIONS.length) % DISPOSITIONS.length;
  return DISPOSITIONS[idx];
}

// 2026-05-02 (round-robin improvement #4): structured-deliberation
// final synthesis. Mirrors buildRoleDiffSynthesisPrompt but for the
// no-roles structured-deliberation case. Lead distills the whole
// transcript into Consensus / Disagreements / Recommended next step.
export function buildStructuredSynthesisPrompt(
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  // 2026-05-02 (improvement #5): directive-aware synthesis. When a
  // directive is set the synthesis MUST answer it directly — adds a
  // dedicated "Answer to directive" section and reframes
  // "Recommended next step" as the next action toward the directive.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the team was deliberating)",
  });
  const structure = dirCtx.hasDirective
    ? [
        "STRUCTURE your response as:",
        "1. **Answer to directive** — direct response to the user's question / request. State what the team concluded, not how it deliberated.",
        "2. **Consensus** — what every agent agreed on while resolving the directive.",
        "3. **Disagreements** — where agents still hold different positions on the directive. Name the agents and their stances.",
        "4. **Recommended next step** — ONE concrete next action toward the directive. Cite files / decisions / experiments. Build on the Builder-disposition turns.",
        "5. **Open questions** — anything the Gap-finder turns surfaced about the directive that the team didn't resolve.",
      ]
    : [
        "STRUCTURE your response as:",
        "1. **Consensus** — what every agent (including you) converged on. State as a direct claim, not a meta-observation.",
        "2. **Disagreements** — where agents still hold different positions. Name the agents and their stances.",
        "3. **Recommended next step** — ONE concrete next action. Cite files / decisions / experiments. Build on the Builder-disposition turns from the discussion.",
        "4. **Open questions** — anything the Gap-finder turns surfaced that the team didn't resolve.",
      ];
  return [
    `You are Agent 1, the deliberation synthesis lead. The team just finished ${totalRounds} round${totalRounds === 1 ? "" : "s"} of structured deliberation across rotating dispositions (Critic / Synthesizer / Gap-finder / Builder).`,
    "Your job NOW is to produce a SINGLE consolidated answer that integrates the whole discussion.",
    "",
    ...directiveBlock,
    ...structure,
    "",
    "Keep under ~500 words. Be specific. Cite file paths when relevant.",
    "",
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — agents largely agree; further rounds would only restate consensus.",
    "  CONVERGENCE: medium — partial consensus with real open questions still in play.",
    "  CONVERGENCE: low    — significant unresolved disagreement; more rounds would help.",
    "",
    "=== FULL TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

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
// 2026-05-03 (Phase A): both parsers consolidated into the shared
// `convergenceSignal.ts` module. This re-export preserves the legacy
// public name for external callers.
export { parseConvergenceSignal as parseRoleDiffConvergence } from "./convergenceSignal.js";
