import { randomUUID } from "node:crypto";
import { createOutcomeEmitter, type OutcomeScoredEvent } from "./outcomeTypes.js";
import type { Agent } from "../services/AgentManager.js";

import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "./../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { userEntryVisibleTo } from "./chatReceipt.js";
import { writeDebateDeliverable } from "./debateDeliverableWriter.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

// runEndReflection moved into runFinallyHooks (Phase D).
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import { describeSdkError } from "./sdkError.js";
import { type DerivedProposition } from "./propositionDerive.js";
import { DebateStream } from "./DebateStream.js";
import {
  DEFAULT_PROPOSITION,
  type ParsedDebateVerdict,
  rankParallelPropositions,
} from "./debatePromptHelpers.js";
import { resolveDebatePropositionAtStart } from "./debatePropositionResolve.js";
import { buildDebateSeedMessage } from "./debateSeed.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import {
  type DebateStreamsHost,
  runSingleStreamDebate as runSingleStreamDebateExtracted,
  runMultiStreamDebate as runMultiStreamDebateExtracted,
  runCrossStreamJudge as runCrossStreamJudgeExtracted,
  runDebaterTurn as runDebaterTurnExtracted,
  runNextActionPhase as runNextActionPhaseExtracted,
  runJudgeTurn as runJudgeTurnExtracted,
} from "./debateStreams.js";

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
export class DebateJudgeRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Debate-Judge"; }

  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.

  // User-supplied proposition override, captured by injectUser before start.
  // Only the most recent pre-start injection counts as the proposition;
  // mid-run injections are treated as regular transcript commentary.
  private proposition?: string;
  // 2026-05-03 (debate-judge improvement #1): when the user gives a
  // directive but no proposition, the judge agent auto-derives a sharp
  // PRO/CON proposition at run start. Stored so the seed can label
  // whether the proposition was derived vs. user-supplied vs. fallback.
  private derivedPropositionMeta: DerivedProposition | null = null;
  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    super.injectUser(text, opts);
    // If the run hasn't started yet (phase is idle), treat the most recent
    // user input as the proposition override. Once the run is underway,
    // injectUser just posts to the transcript as normal.
    if (this.phase === "idle" && text.trim().length > 0) {
      this.proposition = text.trim();
    }
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
    this.resetState(cfg);
    this.proposition = propositionAtStart; // re-set after transcript reset


    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "debate-judge",
      minAgents: 3,
      roleResolver: (a) => (a.index === 1 ? "Pro" : a.index === 2 ? "Con" : "Judge"),
      extraReadyMessage: " Agent 1 = PRO, Agent 2 = CON, Agent 3 = JUDGE.",
    });
    this.stats.registerAgents(ready);

    // Auto-derive proposition from directive when none was supplied.
    const directiveTrimmed = (cfg.userDirective ?? "").trim();
    const judge = ready.find((a) => a.index === 3);
    if (judge) {
      const resolved = await resolveDebatePropositionAtStart({
        proposition: this.proposition,
        parallelPropositions: cfg.parallelPropositions,
        directiveTrimmed,
        judge,
        manager: this.opts.manager,
        appendSystem: (t) => this.appendSystem(t),
      });
      this.proposition = resolved.proposition;
      this.derivedPropositionMeta = resolved.derivedMeta;
    }

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      this.multiWriter = new MultiWriterState({
        writeMode: cfg.writeMode,
        conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["debate-judge"],
        clonePath: destPath,
      });
      this.appendSystem(
        `Multi-writer mode enabled — agents will propose hunks during rounds, reconciled via ${cfg.conflictPolicy ?? "judge"} policy.`,
      );
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    await this.runTrackedLoop(() => this.loop(cfg));
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const { text, summary } = buildDebateSeedMessage({
      clonePath,
      cfg,
      tree,
      proposition: this.proposition,
      derivedPropositionMeta: this.derivedPropositionMeta,
    });
    this.appendSystem(text, summary);
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

      // Task #102: capture the parsed verdict so the post-loop build
      // round can act on it.
      let finalVerdict: ParsedDebateVerdict | null = null;

      // T-Item-2 (2026-05-04): K parallel debate streams. When >1, run
      // K full debates IN PARALLEL (each with a different proposition)
      // + cross-stream judge synthesis to pick the canonical verdict.
      // Caps at 3 (each stream is ~3× cost). PRO + CON agents are
      // REUSED across streams (each prompt is fully self-contained;
      // streams don't share state).
      const K = Math.max(1, Math.min(3, cfg.parallelDebateStreams ?? 1));
      if (K > 1) {
        finalVerdict = await this.runMultiStreamDebate(
          { pro, con, judge },
          K,
          cfg,
        );
      } else {
        finalVerdict = await this.runSingleStreamDebate(
          { pro, con, judge },
          prop,
          cfg,
        );
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
        await this.runNextActionPhase(pro, con, judge, prop, finalVerdict, cfg.userDirective);
      }
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-02 (deliverables initiative): structured markdown
      // before writeSummary. Best-effort.
      if (!this.stopping && cfg.runId) await this.writeDebateDeliverable(cfg);
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // Reflection picks the JUDGE (agent-3) — they see the full debate
      // plus the verdict, so the lessons capture both. Falls back to
      // index-1 if the judge somehow isn't in the live list.
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
          pickReflectionAgent: (m) =>
            m.list().find((a) => a.index === 3) ?? m.list().find((a) => a.index === 1) ?? null,
          buildReflectionContext: (s) =>
            `Debate-judge preset · 3 agents · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

  // 2026-05-02 (deliverables initiative): debate-judge structured
  // artifact. Delegates to the extracted writeDebateDeliverable function.
  private async writeDebateDeliverable(cfg: RunConfig): Promise<void> {
    await writeDebateDeliverable({
      cfg,
      transcript: this.transcript,
      proposition: this.proposition,
      derivedPropositionMeta: this.derivedPropositionMeta,
      earlyStopDetail: this.earlyStopDetail,
      multiWriter: this.multiWriter,
      manager: this.opts.manager,
      repos: this.opts.repos,
      emit: this.opts.emit,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
    });
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  // T-Item-2 (2026-05-04): single-stream N-round debate. Extracted
  // from the original `loop` body so the multi-stream path can reuse
  // the same per-stream rounding logic. When `stream` is undefined,
  // operates on this.transcript directly (legacy single-stream
  // behavior). When set, operates on stream.transcript.
  private debateHost(): DebateStreamsHost {
    return {
      manager: this.opts.manager,
      transcript: this.transcript,
      proposition: this.proposition,
      logDiag: this.opts.logDiag,
      getStopping: () => this.stopping,
      setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
      appendSystem: (t, s) => this.appendSystem(t, s as any),
      checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
      runAgent: (a, p, tag, enr, name, stream) => this.runAgent(a, p, tag, enr, name, stream),
    };
  }

  // Stream/cycle helpers extracted to debateStreams.ts; thin wrappers preserve call sites.
  private async runSingleStreamDebate(
    agents: { pro: Agent; con: Agent; judge: Agent },
    proposition: string,
    cfg: RunConfig,
    stream?: DebateStream,
  ): Promise<ParsedDebateVerdict | null> {
    return runSingleStreamDebateExtracted(this.debateHost(), agents, proposition, cfg, stream);
  }

  private async runMultiStreamDebate(
    agents: { pro: Agent; con: Agent; judge: Agent },
    K: number,
    cfg: RunConfig,
  ): Promise<ParsedDebateVerdict | null> {
    return runMultiStreamDebateExtracted(this.debateHost(), agents, K, cfg);
  }

  private async runCrossStreamJudge(
    judge: Agent,
    streams: readonly DebateStream[],
    cfg: RunConfig,
  ): Promise<string | null> {
    return runCrossStreamJudgeExtracted(this.debateHost(), judge, streams, cfg);
  }

  private async runDebaterTurn(
    agent: Agent,
    side: "pro" | "con",
    round: number,
    totalRounds: number,
    proposition: string,
    isFinalRound: boolean,
    userDirective?: string,
    stream?: DebateStream,
  ): Promise<void> {
    return runDebaterTurnExtracted(
      this.debateHost(),
      agent,
      side,
      round,
      totalRounds,
      proposition,
      isFinalRound,
      userDirective,
      stream,
    );
  }

  private async runNextActionPhase(
    pro: Agent,
    con: Agent,
    judge: Agent,
    proposition: string,
    verdict: ParsedDebateVerdict,
    userDirective?: string,
  ): Promise<void> {
    return runNextActionPhaseExtracted(
      this.debateHost(),
      pro,
      con,
      judge,
      proposition,
      verdict,
      userDirective,
    );
  }

  private async rankParallelPropositions(
    judge: import("../services/AgentManager.js").Agent,
    directive: string,
    propositions: readonly string[],
  ): Promise<number | null> {
    return rankParallelPropositions(judge, this.opts.manager, directive, propositions);
  }

  private async runJudgeTurn(
    judge: Agent,
    proposition: string,
    round: number,
    userDirective?: string,
    stream?: DebateStream,
  ): Promise<ParsedDebateVerdict | null> {
    return runJudgeTurnExtracted(
      this.debateHost(),
      judge,
      proposition,
      round,
      userDirective,
      stream,
      this.active,
    );
  }

  private async runAgent(
    agent: Agent,
    prompt: string,
    debateTag?: { role: "pro" | "con" | "judge"; round: number },
    enrichSummary?: (text: string) => TranscriptEntrySummary | undefined,
    agentName: "swarm" | "swarm-read" = "swarm-read",
    stream?: DebateStream,
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
      // Unit 16: shared retry wrapper.
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = await promptWithFailoverAuto(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        // Unit 20: read-only tools for discussion presets.
        // Task #102: implementer turn opts into "swarm" (write tools).
        agentName,
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
        runner: "debate-judge",
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
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const stripped = finalizeAgentOutput(text, { role: "general" });
      const enriched = enrichSummary?.(stripped.finalText);
      // Phase 2 (writeMode: multi): collect hunk proposals if multi-writer active
      if (this.multiWriter?.isActive()) {
        const proposalResult = await this.multiWriter.addProposal(agent, stripped.finalText);
        if (!proposalResult.skipped && proposalResult.hunks.length > 0) {
          this.appendSystem(
            `[${agent.id}] proposed ${proposalResult.hunks.length} hunk(s)` +
              (proposalResult.fromWorkingTree ? " (workingTree snapshot)" : "") +
              ` — collected for reconciliation.`,
          );
        }
      }
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        summary:
          enriched ??
          (debateTag
            ? { kind: "debate_turn", round: debateTag.round, role: debateTag.role }
            : undefined),
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      // T-Item-2 (2026-05-04): when running inside a parallel-debate
      // stream, route the transcript push through stream.appendEntry so
      // the entry gets the streamId tag AND lands in both the stream's
      // local view (used by per-stream prompt scoping) and the runner's
      // main transcript (used by replay/persistence).
      if (stream) {
        stream.appendEntry(entry, (e) => {
          this.transcript.push(e);
          this.opts.emit({ type: "transcript_append", entry: e });
        });
      } else {
        this.transcript.push(entry);
        this.opts.emit({ type: "transcript_append", entry });
      }
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


