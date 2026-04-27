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
} from "./../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, buildRunFinishedSummary, buildSeedSummary, formatPortReleaseLine, formatRunFinishedBanner, writeRunSummary } from "./runSummary.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { shouldHaltOnQuota, snapshotLifetimeTokens, tokenBudgetExceeded, tokenTracker } from "../services/ollamaProxy.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { runEndReflection } from "./runEndReflection.js";

// Debate + judge.
// Agent 1 = PRO (argues FOR the proposition).
// Agent 2 = CON (argues AGAINST).
// Agent 3 = JUDGE (scores the debate on the final round).
//
// Per round, Pro speaks first, then Con. Both see the running transcript so
// they can rebut each other — that's the point, unlike Council's round-1
// isolation. On the final round, after Pro and Con's closing statements,
// the Judge reads the whole debate and issues a scored verdict.
//
// Proposition defaults to "This project is ready for production use."
// Users can override by injecting a message before starting the run — the
// runner picks up the most recent user-injected text as the proposition.
// Discussion-only, no file edits.
export class DebateJudgeRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // User-supplied proposition override, captured by injectUser before start.
  // Only the most recent pre-start injection counts as the proposition;
  // mid-run injections are treated as regular transcript commentary.
  private proposition?: string;
  // Phase B (Task #94): natural-stop detail when the judge reaches
  // confidence:high mid-loop. Promoted to stopReason="early-stop" by
  // writeSummary. Stays undefined on natural rounds-exhaustion ends.
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
    // If the run hasn't started yet (phase is idle), treat the most recent
    // user input as the proposition override. Once the run is underway,
    // injectUser just posts to the transcript as normal.
    if (this.phase === "idle" && text.trim().length > 0) {
      this.proposition = text.trim();
    }
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
    // Unit 32: cfg.proposition (set from the form's Advanced section)
    // takes precedence over an inject-before-start proposition. Lets
    // users specify the proposition at start time without the
    // inject-before-start workaround. The inject path still works when
    // cfg.proposition is absent — same as pre-Unit-32 behavior.
    if (cfg.proposition && cfg.proposition.trim().length > 0) {
      this.proposition = cfg.proposition.trim();
    }
    const propositionAtStart = this.proposition;
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.earlyStopDetail = undefined;
    this.proposition = propositionAtStart; // re-set after transcript reset

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
    const spawnStart = Date.now();
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length !== 3) {
      throw new Error(
        `Debate + judge requires exactly 3 agents (got ${ready.length}). Agent 1 = Pro, Agent 2 = Con, Agent 3 = Judge.`,
      );
    }
    this.appendSystem(
      `3 agents ready on ports ${ready.map((a) => a.port).join(", ")}. Agent 1 = PRO, Agent 2 = CON, Agent 3 = JUDGE.`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: "debate-judge",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: (a) => (a.index === 1 ? "Pro" : a.index === 2 ? "Con" : "Judge"),
      }),
    );
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
    const prop = this.proposition ?? DEFAULT_PROPOSITION;
    const seed = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      `Proposition under debate: "${prop}"`,
      "Agent 1 (PRO) argues FOR the proposition.",
      "Agent 2 (CON) argues AGAINST.",
      "Agent 3 (JUDGE) stays silent until the final round, then reads the full debate and scores.",
    ].join("\n");
    this.appendSystem(seed, buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const pro = agents.find((a) => a.index === 1);
      const con = agents.find((a) => a.index === 2);
      const judge = agents.find((a) => a.index === 3);
      if (!pro || !con || !judge) throw new Error("Pro/Con/Judge must all spawn (agents 1, 2, 3)");
      const prop = this.proposition ?? DEFAULT_PROPOSITION;

      // Phase B (Task #94): one preliminary judge pass at the loop
      // midpoint. If the judge says confidence:high we end early —
      // continuing past a confident verdict just burns tokens. Pick a
      // single fire-point (not every round) so the judge cost is at
      // most one extra call beyond the canonical final-round verdict.
      const earlyCheckRound = cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;

      // Task #102: capture the parsed verdict so the post-loop build
      // round can act on it.
      let finalVerdict: ParsedDebateVerdict | null = null;

      // Task #124: snapshot lifetime tokens for budget delta.
      const tokenBaseline = snapshotLifetimeTokens();
      // Task #146: same dead-loop guard as #144 in OW. By round ~15 of a
      // long debate, the transcript passed to PRO/CON has bloated and the
      // model can return "(empty response)" placeholder for every turn.
      // Track consecutive rounds where all new agent entries are empty/junk;
      // break when threshold hit.
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

        const isFinalRound = r === cfg.rounds;
        const transcriptLenBefore = this.transcript.length;
        // PRO turn
        await this.runDebaterTurn(pro, "pro", r, cfg.rounds, prop, isFinalRound);
        if (this.stopping) break;
        // CON turn
        await this.runDebaterTurn(con, "con", r, cfg.rounds, prop, isFinalRound);
        if (this.stopping) break;
        // Task #146: dead-loop guard. If both PRO and CON produced empty/junk
        // output this round, count it. After N consecutive empty rounds, break.
        const newEntries = this.transcript
          .slice(transcriptLenBefore)
          .filter((e) => e.role === "agent");
        const allEmpty = newEntries.length > 0 &&
          newEntries.every((e) => (e.text || "") === "(empty response)" || looksLikeJunk(e.text || ""));
        if (allEmpty) {
          consecutiveEmptyRounds++;
          if (consecutiveEmptyRounds >= EMPTY_ROUND_BREAK_THRESHOLD) {
            this.earlyStopDetail = `agents-silenced (${consecutiveEmptyRounds} consecutive empty rounds)`;
            this.appendSystem(
              `Both debaters produced empty/junk output for ${consecutiveEmptyRounds} consecutive rounds — ending debate early.`,
            );
            break;
          }
        } else {
          consecutiveEmptyRounds = 0;
        }
        // JUDGE turn (only on the final round, OR mid-loop when we
        // hit the early-check checkpoint).
        if (isFinalRound) {
          finalVerdict = await this.runJudgeTurn(judge, prop, r);
        } else if (r === earlyCheckRound) {
          finalVerdict = await this.runJudgeTurn(judge, prop, r);
          if (finalVerdict?.confidence === "high") {
            this.earlyStopDetail =
              `judge-confidence-high after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `Judge reached confidence:high at round ${r}/${cfg.rounds} — ending debate early.`,
            );
            break;
          }
        }
      }
      if (!this.stopping) this.appendSystem("Debate concluded.");

      // Phase B (Task #102): post-verdict "build" round. Opt-in via
      // cfg.executeNextAction. Skip on tie or low-confidence verdicts
      // (don't act on uncertain conclusions). PRO becomes implementer
      // and gets file-edit tools (agentName "swarm" instead of
      // "swarm-read") to actually action the verdict's nextAction;
      // CON reviews; JUDGE signs off.
      if (
        !this.stopping &&
        cfg.executeNextAction &&
        finalVerdict &&
        finalVerdict.winner !== "tie" &&
        finalVerdict.confidence !== "low" &&
        finalVerdict.nextAction.trim().length > 0
      ) {
        await this.runNextActionPhase(pro, con, judge, prop, finalVerdict);
      }
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // Task #150: end-of-run reflection. Use the JUDGE (agent-3) — they
      // see the full debate plus the verdict, so the lessons capture both.
      if (!crashMessage && !this.stopping && cfg.runId) {
        const lead = this.opts.manager.list().find((a) => a.index === 3)
          ?? this.opts.manager.list().find((a) => a.index === 1);
        if (lead) {
          const ctxSummary = `Debate-judge preset · 3 agents · ran ${this.round}/${cfg.rounds} rounds${this.earlyStopDetail ? ` · early-stop: ${this.earlyStopDetail}` : ""}`;
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

  private async runDebaterTurn(
    agent: Agent,
    side: "pro" | "con",
    round: number,
    totalRounds: number,
    proposition: string,
    isFinalRound: boolean,
  ): Promise<void> {
    const prompt = buildDebaterPrompt({
      side,
      round,
      totalRounds,
      proposition,
      isFinalRound,
      transcript: [...this.transcript],
    });
    // Phase 2c: tag so VerdictPanel can group PRO/CON pairs by round.
    await this.runAgent(agent, prompt, { role: side, round });
  }

  // Task #102: post-verdict "build" round. Three turns total (one
  // per agent), only fires when the user opted in via
  // cfg.executeNextAction AND the verdict is high/medium confidence
  // with a non-tie winner. PRO uses write-capable tools to action
  // the verdict's nextAction; CON inspects the changes and flags
  // issues; JUDGE signs off (or rejects).
  private async runNextActionPhase(
    pro: Agent,
    con: Agent,
    judge: Agent,
    proposition: string,
    verdict: ParsedDebateVerdict,
  ): Promise<void> {
    this.appendSystem(
      `Build phase: PRO will implement the next-action recommendation; CON reviews; JUDGE signs off.`,
      { kind: "next_action_phase", role: "announcement" },
    );

    // Implementer (PRO with write tools)
    if (this.stopping) return;
    const implPrompt = buildImplementerPrompt(proposition, verdict);
    await this.runAgent(
      pro,
      implPrompt,
      undefined,
      () => ({ kind: "next_action_phase", role: "implementer" }),
      "swarm",
    );

    // Task #135: scan the implementer's last entry for evidence of
    // actual edits (CHANGED: lines or src-path:line citations). When
    // missing, log a structured diagnostic so the next signoff-rejection
    // failure has data to RCA from. Doesn't retry — the reviewer +
    // signoff still see the text and can call it out, this is purely
    // observability for now.
    const lastImpl = this.transcript[this.transcript.length - 1];
    if (lastImpl?.role === "agent") {
      const noopHints = scanImplementerForNoOp(lastImpl.text);
      if (noopHints.likelyNoOp) {
        this.opts.logDiag?.({
          type: "debate_implementer_noop_suspected",
          agentId: lastImpl.agentId,
          reasons: noopHints.reasons,
          textLen: lastImpl.text.length,
          ts: Date.now(),
        });
        this.appendSystem(
          `Implementer warning: response shows no evidence of edits (${noopHints.reasons.join(", ")}). Reviewer/signoff may reject.`,
          { kind: "next_action_phase", role: "announcement" },
        );
      }
    }

    // Reviewer (CON, read-only)
    if (this.stopping) return;
    const reviewerPrompt = buildReviewerPrompt(proposition, verdict, [...this.transcript]);
    await this.runAgent(
      con,
      reviewerPrompt,
      undefined,
      () => ({ kind: "next_action_phase", role: "reviewer" }),
    );

    // Signoff (JUDGE, read-only)
    if (this.stopping) return;
    const signoffPrompt = buildSignoffPrompt(proposition, verdict, [...this.transcript]);
    await this.runAgent(
      judge,
      signoffPrompt,
      undefined,
      () => ({ kind: "next_action_phase", role: "signoff" }),
    );
  }

  private async runJudgeTurn(
    judge: Agent,
    proposition: string,
    round: number,
  ): Promise<ParsedDebateVerdict | null> {
    const prompt = buildJudgePrompt({ proposition, transcript: [...this.transcript] });
    // Task #81: try to parse the JUDGE response as a structured
    // verdict and upgrade the summary tag. Falls back to plain
    // debate_turn if JSON parse fails — the freeform text still
    // lands in the transcript.
    // Task #94: capture the parsed verdict so the loop can use
    // confidence:high as an early-stop signal.
    let parsed: ParsedDebateVerdict | null = null;
    await this.runAgent(judge, prompt, { role: "judge", round }, (text) => {
      parsed = parseDebateVerdict(text);
      if (!parsed) return undefined;
      return { kind: "debate_verdict", round, ...parsed };
    });
    return parsed;
  }

  // Phase 2c: transcript tag so the VerdictPanel can identify each
  // turn's role + round without guessing by agent-index order.
  // Task #81: enrichSummary lets the caller (e.g. runJudgeTurn)
  // post-process the text and upgrade the basic debate_turn tag to
  // a richer kind like debate_verdict.
  // Task #102: agentName param defaults to "swarm-read" (preserves
  // existing discussion-only behavior) — debate/judge turns pass it
  // through; the post-verdict implementer turn passes "swarm" to get
  // file-edit tools.
  private async runAgent(
    agent: Agent,
    prompt: string,
    debateTag?: { role: "pro" | "con" | "judge"; round: number },
    enrichSummary?: (text: string) => TranscriptEntrySummary | undefined,
    agentName: "swarm" | "swarm-read" = "swarm-read",
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
      abortSession: () => agent.client.session.abort({ path: { id: agent.sessionId } }).then(() => {}),
    });

    try {
      // Unit 16: shared retry wrapper.
      const res = await promptWithRetry(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        // Unit 20: read-only tools for discussion presets.
        // Task #102: implementer turn opts into "swarm" (write tools).
        agentName,
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
        runner: "debate-judge",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      // Task #54: retry on model silence (see CouncilRunner for detail).
      // Pattern 8: retry on junk-short single-token output too.
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(agent, prompt, agentName, diagCtx);
        if (retryText !== null) text = retryText;
      }
      // Task #115: track Pattern 8 stuck-loop, warn on threshold.
      trackPostRetryJunk(text, {
        agentId: agent.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      // Task #81: prefer the enriched summary when the caller provides
      // one (JUDGE upgrades to debate_verdict). Fall back to the
      // basic debate_turn tag for PRO/CON.
      const enriched = enrichSummary?.(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
        ts: Date.now(),
        summary:
          enriched ??
          (debateTag
            ? { kind: "debate_turn", round: debateTag.round, role: debateTag.role }
            : undefined),
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

export const DEFAULT_PROPOSITION = "This project is ready for production use.";

interface BuildDebaterPromptArgs {
  side: "pro" | "con";
  round: number;
  totalRounds: number;
  proposition: string;
  isFinalRound: boolean;
  transcript: readonly TranscriptEntry[];
}

export function buildDebaterPrompt(args: BuildDebaterPromptArgs): string {
  const { side, round, totalRounds, proposition, isFinalRound, transcript } = args;
  const role = side === "pro" ? "PRO (arguing FOR)" : "CON (arguing AGAINST)";
  const stance = side === "pro" ? "FOR" : "AGAINST";
  const agentIndex = side === "pro" ? 1 : 2;

  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  const roundBrief = isFinalRound
    ? "This is the FINAL round — make your closing statement. Summarize your strongest points, directly address your opponent's strongest points, and make clear WHY the judge should decide in your favor."
    : `This is round ${round} of ${totalRounds}. Make your strongest case this round. Rebut your opponent's prior argument specifically (quote or paraphrase a line they made) rather than talking past them.`;

  return [
    `You are Agent ${agentIndex}, the ${role} debater in a structured debate.`,
    `Proposition: "${proposition}"`,
    `Your job: argue ${stance} the proposition.`,
    roundBrief,
    "",
    "Your working directory IS the project clone — you may use file-read, grep, and find-files tools to gather evidence for your position.",
    "Keep responses under ~300 words. Cite file paths (e.g. `src/foo.ts:42`) where relevant — concrete evidence beats abstract argument.",
    "Do NOT flip sides. Do NOT concede the proposition — your role is adversarial. If the evidence genuinely contradicts your side, find a narrower framing that's still defensible.",
    "",
    "=== DEBATE TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — you open the debate)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex} (${role}).`,
  ].join("\n");
}

interface BuildJudgePromptArgs {
  proposition: string;
  transcript: readonly TranscriptEntry[];
}

export function buildJudgePrompt(args: BuildJudgePromptArgs): string {
  const { proposition, transcript } = args;
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  // Task #81 (2026-04-25): structured verdict. Previously freeform
  // text; now JSON envelope so the modal renders a scorecard.
  // Parser is lenient — falls back to freeform-as-rationale if model
  // doesn't comply with JSON shape.
  return [
    "You are Agent 3, the JUDGE of a structured debate.",
    `Proposition: "${proposition}"`,
    "",
    "Your job: score the debate on the MERITS of the arguments presented, not on your prior opinion of the proposition. Score independently — a weaker argument for the 'correct' side should lose to a stronger argument for the 'wrong' side.",
    "",
    "Output ONLY a JSON object matching this shape (no prose, no fences, no commentary):",
    "{",
    '  "winner": "pro" | "con" | "tie",',
    '  "confidence": "low" | "medium" | "high",',
    '  "proStrongest": "1-2 sentences naming PRO\'s best argument",',
    '  "conStrongest": "1-2 sentences naming CON\'s best argument",',
    '  "proWeakest": "1-2 sentences naming PRO\'s weakest point",',
    '  "conWeakest": "1-2 sentences naming CON\'s weakest point",',
    '  "decisive": "1 sentence — what tipped the balance",',
    '  "nextAction": "1 sentence — concrete action a developer should take given this verdict, or \\"none needed\\""',
    "}",
    "",
    "Cite debaters as 'PRO' / 'CON' (not Agent 1 / Agent 2) inside the strings for readability.",
    "",
    "=== FULL DEBATE TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now produce the JSON verdict.",
  ].join("\n");
}

// Task #135: heuristic "did the implementer actually do anything?"
// scanner. Looks for two positive signals:
//   1. an explicit `CHANGED:` line (the format the prompt requires)
//   2. at least one src-style path with a line number (e.g. src/foo.ts:42)
// Absent BOTH, the response is almost certainly narration-only and the
// signoff will reject it. Pure observability — emits a log + system
// note so the next failure has the diagnostic upstream of the verdict.
export function scanImplementerForNoOp(text: string): {
  likelyNoOp: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const hasChangedTag = /^\s*CHANGED:\s*/im.test(text);
  // Match common path:line patterns — e.g. src/foo.ts:42, ./bar/baz.tsx:1
  // Excludes URL-like matches (http://...) by requiring a slash-separated
  // path prefix without a colon-after-scheme.
  const pathLineRegex = /(?:^|\s|`|"|\()(?:\.{1,2}\/)?[a-zA-Z_][\w./-]*\.[a-zA-Z]{1,5}:\d+/m;
  const hasPathCitation = pathLineRegex.test(text);
  if (!hasChangedTag) reasons.push("no CHANGED: tag");
  if (!hasPathCitation) reasons.push("no path:line citation");
  // Mention of explicit no-op acknowledgement is fine — the prompt
  // allows `CHANGED: (none — reason: …)` so the reviewer can decide.
  // Don't flag those as suspicious.
  const isAcknowledgedNoOp = /CHANGED:\s*\(none\b/i.test(text);
  if (isAcknowledgedNoOp) {
    return { likelyNoOp: false, reasons: [] };
  }
  return { likelyNoOp: !hasChangedTag && !hasPathCitation, reasons };
}

// Task #102: post-verdict build phase prompts. Each turn (PRO=
// implementer, CON=reviewer, JUDGE=signoff) gets a focused prompt
// that frames its job in terms of the verdict's nextAction. The
// implementer is the only turn with file-edit tools.
export function buildImplementerPrompt(
  proposition: string,
  verdict: ParsedDebateVerdict,
): string {
  return [
    `You are now the IMPLEMENTER (formerly PRO debater). The debate concluded with the JUDGE recommending a concrete next action — your job is to action it on the codebase.`,
    `Original proposition: "${proposition}"`,
    `Verdict winner: ${verdict.winner.toUpperCase()} · confidence: ${verdict.confidence}`,
    "",
    `=== NEXT ACTION TO IMPLEMENT ===`,
    verdict.nextAction,
    `=== END ===`,
    "",
    "You have file-edit tools available (write/edit/create). Use them.",
    "1. Read the relevant files first — understand the current state before changing.",
    "2. Make the smallest concrete change that meaningfully advances the next-action recommendation. Do NOT try to do everything; one focused edit is better than a sprawling one.",
    "3. After editing, write a short report (under ~250 words) describing: which files you changed, what you changed and why, and what you deliberately did NOT change so the reviewer knows your scope.",
    "",
    "Cite paths (e.g. `src/foo.ts:42`). Be specific. If the next-action is genuinely impossible to action with file edits (e.g. \"talk to legal\"), say so explicitly and explain why — do NOT pretend to act.",
    "",
    // Task #135: signoff has been observed REJECTING implementer turns
    // that contain only narration ("I will read foo.ts and add bar")
    // with no actual edits + no concrete file:line citations. Make the
    // expected report shape explicit so the model has nowhere to hide.
    "Required report format (omitting any of these will be rejected by the reviewer):",
    "  CHANGED: <file path>:<line range> — <what you changed>",
    "  CHANGED: <file path>:<line range> — <what you changed>   (one line per file touched)",
    "  RATIONALE: <one paragraph why these specific edits action the next-action>",
    "  OUT OF SCOPE: <what you intentionally did NOT change>",
    "",
    "If you did not actually invoke a file-edit tool this turn, say `CHANGED: (none — reason: <one sentence>)` so the reviewer knows. Narration without edits is a rejection.",
  ].join("\n");
}

export function buildReviewerPrompt(
  proposition: string,
  verdict: ParsedDebateVerdict,
  transcript: readonly TranscriptEntry[],
): string {
  // Only show the implementer's report (the most recent agent entry)
  // — reviewer doesn't need the full debate history again, just the
  // implementer's claims to verify.
  const lastImpl = [...transcript]
    .reverse()
    .find(
      (e) =>
        e.role === "agent" &&
        e.summary &&
        (e.summary as { kind?: string }).kind === "next_action_phase" &&
        (e.summary as { role?: string }).role === "implementer",
    );
  const implReport = lastImpl?.text ?? "(no implementer report found)";
  return [
    `You are now the REVIEWER (formerly CON debater). The IMPLEMENTER just made changes to the codebase to action the JUDGE's next-action recommendation.`,
    `Original proposition: "${proposition}"`,
    `Verdict next-action: ${verdict.nextAction}`,
    "",
    "=== IMPLEMENTER'S REPORT ===",
    implReport,
    "=== END REPORT ===",
    "",
    "Your job: VERIFY the implementer's claims by independently inspecting the changed files. You have read-only tools (file-read / grep / find).",
    "1. Read the files the implementer claims to have changed. Confirm the changes are actually there.",
    "2. Look for issues: did the implementer break anything? Did they overreach (changes outside scope)? Did they leave gaps (changes that don't fully action the next-action)?",
    "3. Write a short review (under ~250 words). Use the format:",
    "   - VERIFIED: <what you confirmed is correctly done>",
    "   - CONCERNS: <issues you found, if any>",
    "   - GAPS: <what's still missing relative to the next-action>",
    "",
    "Be honest — your role is adversarial. If the implementation is bad or off-target, say so concretely.",
  ].join("\n");
}

export function buildSignoffPrompt(
  proposition: string,
  verdict: ParsedDebateVerdict,
  transcript: readonly TranscriptEntry[],
): string {
  // Show implementer + reviewer entries; judge needs both to sign off.
  const phaseEntries = transcript.filter(
    (e) =>
      e.role === "agent" &&
      e.summary &&
      (e.summary as { kind?: string }).kind === "next_action_phase",
  );
  const phaseText = phaseEntries
    .map((e) => {
      const role = (e.summary as { role?: string }).role ?? "?";
      return `[${role.toUpperCase()}] ${e.text}`;
    })
    .join("\n\n");
  return [
    `You are still the JUDGE. The IMPLEMENTER actioned your next-action recommendation; the REVIEWER inspected the changes. Now you sign off.`,
    `Original proposition: "${proposition}"`,
    `Verdict next-action: ${verdict.nextAction}`,
    "",
    "=== BUILD-PHASE TRANSCRIPT ===",
    phaseText,
    "=== END ===",
    "",
    "You may use read-only tools to spot-check anything the reviewer flagged.",
    "Decide ONE outcome:",
    "  ACCEPTED — the implementation correctly actions the next-action; the run is done.",
    "  PARTIAL  — meaningful progress made, but real gaps remain that a future iteration should close.",
    "  REJECTED — implementation is wrong / harmful / off-target; revert.",
    "",
    "Write your decision on the FIRST line as one of: ACCEPTED, PARTIAL, REJECTED.",
    "Then a short paragraph (under ~150 words) justifying the call, citing the implementer's actual changes and the reviewer's concerns.",
  ].join("\n");
}

// Task #81: lenient parser for the JUDGE's JSON verdict. Same three-
// strategy approach as transcriptSummary.tryParseJson — strict, fence-
// strip, slice-between-braces — so a model that wraps in ```json or
// emits prose around the object still gets the structured tag.
export interface ParsedDebateVerdict {
  winner: "pro" | "con" | "tie";
  confidence: "low" | "medium" | "high";
  proStrongest: string;
  conStrongest: string;
  proWeakest: string;
  conWeakest: string;
  decisive: string;
  nextAction: string;
}
export function parseDebateVerdict(raw: string): ParsedDebateVerdict | null {
  const obj = parseLooseJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const winner = o.winner;
  const confidence = o.confidence;
  if (winner !== "pro" && winner !== "con" && winner !== "tie") return null;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return null;
  const str = (k: string): string =>
    typeof o[k] === "string" ? (o[k] as string).trim() : "";
  return {
    winner,
    confidence,
    proStrongest: str("proStrongest"),
    conStrongest: str("conStrongest"),
    proWeakest: str("proWeakest"),
    conWeakest: str("conWeakest"),
    decisive: str("decisive"),
    nextAction: str("nextAction"),
  };
}
function parseLooseJson(raw: string): unknown {
  const s = raw.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(s);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()); } catch { /* fall through */ }
  }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(s.slice(firstBrace, lastBrace + 1)); } catch { /* fall through */ }
  }
  return null;
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
