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
} from "./../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { extractText } from "./extractText.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { userEntryVisibleTo } from "./chatReceipt.js";
import { writeDebateDeliverable } from "./debateDeliverableWriter.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { deriveProposition, type DerivedProposition } from "./propositionDerive.js";
import { DebateStream } from "./DebateStream.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import {
  DEFAULT_PROPOSITION,
  buildDebaterPrompt,
  buildJudgePrompt,
  scanImplementerForNoOp,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildSignoffPrompt,
  type ParsedDebateVerdict,
  parseDebateVerdict,
  buildCrossStreamJudgePrompt,
  parseCrossStreamPick,
  rankParallelPropositions,
} from "./debatePromptHelpers.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";

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
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
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
    this.stats.reset();
    this.proposition = propositionAtStart; // re-set after transcript reset


    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "debate-judge",
      minAgents: 3,
      roleResolver: (a) => (a.index === 1 ? "Pro" : a.index === 2 ? "Con" : "Judge"),
      extraReadyMessage: " Agent 1 = PRO, Agent 2 = CON, Agent 3 = JUDGE.",
    });
    this.stats.registerAgents(ready);

    // 2026-05-03 (debate-judge improvement #1): auto-derive proposition
    // from cfg.userDirective when no Proposition was supplied. Judge
    // agent (index 3) does the derivation — they're idle during the
    // debate rounds anyway, so reusing them here costs no critical-path
    // wall-clock. Best-effort: any failure falls back to a pass-through
    // proposition; the debate always proceeds.
    const directiveTrimmed = (cfg.userDirective ?? "").trim();
    if (
      (this.proposition === undefined || this.proposition.length === 0) &&
      directiveTrimmed.length > 0
    ) {
      const judge = ready.find((a) => a.index === 3);
      if (judge) {
        // T198d (2026-05-04): parallel proposition derivation. When
        // cfg.parallelPropositions is set, derive K candidate
        // propositions sequentially + ask judge to pick the most
        // informative ONE before debate starts. First-cut: sequential
        // generation (not parallel debate streams). Hedges against
        // bad framing by giving the judge multiple candidates to
        // weigh against each other.
        if (cfg.parallelPropositions) {
          // T199 (2026-05-04): real parallel proposition derivation.
          // Promote T198d's sequential generation to: K candidates IN
          // PARALLEL (Promise.all) + dedicated judge-rank step that
          // picks the most informative based on debatable surface
          // area + grounding + non-trivial framing. Falls back to
          // first-non-fallback when the rank step fails to parse.
          this.appendSystem(
            `[T199 parallel propositions] Generating 3 candidates IN PARALLEL; judge will rank + pick the most informative.`,
          );
          const candidates: DerivedProposition[] = (
            await Promise.all([
              deriveProposition({
                agent: judge,
                manager: this.opts.manager,
                directive: directiveTrimmed,
              }),
              deriveProposition({
                agent: judge,
                manager: this.opts.manager,
                directive: directiveTrimmed,
              }),
              deriveProposition({
                agent: judge,
                manager: this.opts.manager,
                directive: directiveTrimmed,
              }),
            ])
          ).filter((c): c is DerivedProposition => c !== null);
          if (candidates.length > 0) {
            // Dedup by proposition text (trim + lowercase) — N parallel
            // calls often produce identical strings.
            const seen = new Set<string>();
            const unique = candidates.filter((c) => {
              const k = c.proposition.trim().toLowerCase();
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            // Judge picks: when 1 unique → use it. When 2+ → fire one
            // dedicated rank prompt asking the judge to pick by
            // index. Fallback to first-non-fallback on parse failure.
            let winner: DerivedProposition;
            if (unique.length === 1) {
              winner = unique[0]!;
            } else {
              const pickedIdx = await this.rankParallelPropositions(
                judge,
                directiveTrimmed,
                unique.map((c) => c.proposition),
              );
              winner =
                pickedIdx !== null && pickedIdx >= 0 && pickedIdx < unique.length
                  ? unique[pickedIdx]!
                  : unique.find((c) => c.derived) ?? unique[0]!;
            }
            this.derivedPropositionMeta = winner;
            this.proposition = winner.proposition;
            this.appendSystem(
              `[T199] ${candidates.length} candidates generated, ${unique.length} unique; picked: "${winner.proposition}". Other unique candidates: ${unique
                .filter((c) => c !== winner)
                .map((c) => `"${c.proposition.slice(0, 60)}…"`)
                .join("; ") || "(none)"}.`,
            );
          }
        } else {
          this.appendSystem(
            `Auto-deriving debate proposition from directive (improvement #1)…`,
          );
          const derived = await deriveProposition({
            agent: judge,
            manager: this.opts.manager,
            directive: directiveTrimmed,
          });
          if (derived) {
            this.derivedPropositionMeta = derived;
            this.proposition = derived.proposition;
            const sourceLabel = derived.derived
              ? "auto-derived from directive"
              : "fallback (auto-derive failed)";
            this.appendSystem(
              `Proposition (${sourceLabel}): "${derived.proposition}"${derived.rationale ? ` — ${derived.rationale}` : ""}`,
            );
          }
        }
      }
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
    void this.loop(cfg);
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const prop = this.proposition ?? DEFAULT_PROPOSITION;
    // 2026-05-03 (debate-judge improvement #2): surface the directive
    // alongside the proposition when both are present. The proposition
    // is what PRO/CON debate; the directive is the broader work this
    // decision informs (the implementer's nextAction targets it).
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    // Compose proposition-source annotation lines (only when auto-derived,
    // and only when directive is set so it appears next to the directive).
    const propositionSourceLines: string[] = [];
    if (dirCtx.hasDirective && this.derivedPropositionMeta) {
      const sourceLabel = this.derivedPropositionMeta.derived
        ? "auto-derived from directive"
        : "fallback (auto-derive failed)";
      propositionSourceLines.push(
        `_Proposition source: ${sourceLabel}._${this.derivedPropositionMeta.rationale ? ` ${this.derivedPropositionMeta.rationale}` : ""}`,
      );
    }
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the broader work this debate informs)",
        framingLines: propositionSourceLines,
      }),
      `Proposition under debate: "${prop}"`,
      "Agent 1 (PRO) argues FOR the proposition.",
      "Agent 2 (CON) argues AGAINST.",
      "Agent 3 (JUDGE) stays silent until the final round, then reads the full debate and scores.",
    ];
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
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
        emitOutcome: (outcome: any) => this.opts.emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions }),
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

  // T-Item-2 (2026-05-04): single-stream N-round debate. Extracted
  // from the original `loop` body so the multi-stream path can reuse
  // the same per-stream rounding logic. When `stream` is undefined,
  // operates on this.transcript directly (legacy single-stream
  // behavior). When set, operates on stream.transcript.
  private async runSingleStreamDebate(
    agents: { pro: Agent; con: Agent; judge: Agent },
    proposition: string,
    cfg: RunConfig,
    stream?: DebateStream,
  ): Promise<ParsedDebateVerdict | null> {
    const { pro, con, judge } = agents;
    // Phase B (Task #94): one preliminary judge pass at the loop
    // midpoint. If the judge says confidence:high we end early —
    // continuing past a confident verdict just burns tokens.
    const earlyCheckRound = cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;
    let finalVerdict: ParsedDebateVerdict | null = null;
    // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
    const tokenBaseline = snapshotLifetimeTokens();
    const deadLoopGuard = new OutputEmptyDeadLoopGuard({
      roleLabel: "agents",
      unit: "round",
    });
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
      // In stream-mode, this.round becomes the max round any stream
      // has reached so far — informational only (UI sparkline).
      if (r > this.round) this.round = r;
      this.opts.emit({ type: "swarm_state", phase: "discussing", round: this.round });

      const isFinalRound = r === cfg.rounds;
      // Track stream-local OR main-transcript additions for the
      // dead-loop guard. Stream-mode reads stream.transcript; legacy
      // single-stream reads this.transcript.
      const transcriptLenBefore = stream
        ? stream.transcript.length
        : this.transcript.length;
      // PRO turn
      await this.runDebaterTurn(pro, "pro", r, cfg.rounds, proposition, isFinalRound, cfg.userDirective, stream);
      if (this.stopping) break;
      // CON turn
      await this.runDebaterTurn(con, "con", r, cfg.rounds, proposition, isFinalRound, cfg.userDirective, stream);
      if (this.stopping) break;
      // Task #146: dead-loop guard. If both PRO and CON produced empty/junk
      // output this round, count it. After N consecutive empty rounds, break.
      const tail = stream
        ? stream.transcript.slice(transcriptLenBefore)
        : this.transcript.slice(transcriptLenBefore);
      const newEntries = tail.filter((e) => e.role === "agent");
      const dlHit = deadLoopGuard.recordIteration(newEntries);
      if (dlHit.tripped) {
        this.earlyStopDetail = dlHit.earlyStopDetail;
        this.appendSystem(
          `Both debaters produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending debate early${stream ? ` (${stream.id})` : ""}.`,
        );
        break;
      }
      // JUDGE turn (only on the final round, OR mid-loop when we
      // hit the early-check checkpoint).
      if (isFinalRound) {
        finalVerdict = await this.runJudgeTurn(judge, proposition, r, cfg.userDirective, stream);
      } else if (r === earlyCheckRound) {
        finalVerdict = await this.runJudgeTurn(judge, proposition, r, cfg.userDirective, stream);
        if (finalVerdict?.confidence === "high") {
          // Multi-stream mode: each stream may early-stop independently.
          // We DON'T set this.earlyStopDetail in that case (it would
          // misleadingly imply the whole run early-stopped).
          if (!stream) {
            this.earlyStopDetail =
              `judge-confidence-high after round ${r}/${cfg.rounds}`;
          }
          this.appendSystem(
            `Judge reached confidence:high at round ${r}/${cfg.rounds}${stream ? ` (${stream.id})` : ""} — ending debate early.`,
          );
          break;
        }
      }
    }
    return finalVerdict;
  }

  // T-Item-2 (2026-05-04): K parallel debate streams. Derives K
  // distinct propositions in parallel, creates K DebateStream
  // instances (sharing PRO + CON agents), runs all K debates IN
  // PARALLEL, then fires ONE cross-stream judge synthesis prompt to
  // pick the canonical verdict.
  //
  // Returns the canonical verdict — picked from the winning stream.
  // If cross-stream synthesis fails to parse, falls back to the
  // first stream with a non-null verdict.
  private async runMultiStreamDebate(
    agents: { pro: Agent; con: Agent; judge: Agent },
    K: number,
    cfg: RunConfig,
  ): Promise<ParsedDebateVerdict | null> {
    const { pro, con, judge } = agents;
    this.appendSystem(
      `[T-Item-2 parallel debate streams] K=${K} debates running IN PARALLEL with different propositions; cross-stream judge will pick the canonical verdict.`,
    );
    // Derive K propositions in parallel. The directive is required —
    // without it we have nothing to derive variants from. Falls back
    // to repeating the canonical proposition across streams (rare
    // edge case; multi-stream mostly meaningful with a directive).
    const directiveTrimmed = (cfg.userDirective ?? "").trim();
    const propositions: string[] = [];
    if (directiveTrimmed.length > 0) {
      const candidates: DerivedProposition[] = (
        await Promise.all(
          Array.from({ length: K }, () =>
            deriveProposition({
              agent: judge,
              manager: this.opts.manager,
              directive: directiveTrimmed,
            }),
          ),
        )
      ).filter((c): c is DerivedProposition => c !== null);
      const seen = new Set<string>();
      for (const c of candidates) {
        const key = c.proposition.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        propositions.push(c.proposition);
        if (propositions.length === K) break;
      }
    }
    // Pad if we didn't get K unique candidates (or the directive was
    // empty). Reuse the canonical proposition for the remaining slots.
    const fallback = this.proposition ?? DEFAULT_PROPOSITION;
    while (propositions.length < K) propositions.push(fallback);
    this.appendSystem(
      `[T-Item-2] generated ${propositions.length} stream propositions: ${propositions.map((p, i) => `\n  [stream-${i + 1}] "${p}"`).join("")}`,
    );

    const streams = propositions.map(
      (p, i) => new DebateStream({ id: `stream-${i + 1}`, proposition: p, pro, con }),
    );
    // Run all K debates in parallel. Each call mutates its own stream.
    await Promise.all(
      streams.map((s) =>
        this.runSingleStreamDebate(agents, s.proposition, cfg, s).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`[T-Item-2] ${s.id} failed: ${msg}`);
          return null;
        }),
      ),
    );
    if (this.stopping) return null;

    // Cross-stream synthesis: pick the most informative verdict.
    const settled = streams.filter((s) => s.verdict !== null);
    if (settled.length === 0) {
      this.appendSystem(`[T-Item-2] all ${K} streams failed to produce a verdict.`);
      return null;
    }
    if (settled.length === 1) {
      this.appendSystem(
        `[T-Item-2] only 1 stream produced a verdict (${settled[0]!.id}); using it as canonical.`,
      );
      return settled[0]!.verdict;
    }
    const pickedId = await this.runCrossStreamJudge(judge, streams, cfg);
    const winner = streams.find((s) => s.id === pickedId) ?? settled[0]!;
    this.appendSystem(
      `[T-Item-2] cross-stream judge picked ${winner.id} (proposition: "${winner.proposition}") as canonical verdict.`,
    );
    return winner.verdict;
  }

  // T-Item-2 (2026-05-04): cross-stream judge. Returns the picked
  // stream id or null on failure (caller falls back to first settled).
  private async runCrossStreamJudge(
    judge: Agent,
    streams: readonly DebateStream[],
    cfg: RunConfig,
  ): Promise<string | null> {
    const prompt = buildCrossStreamJudgePrompt({
      streams: streams.map((s) => ({
        id: s.id,
        proposition: s.proposition,
        verdict: s.verdict,
      })),
      userDirective: cfg.userDirective,
    });
    let raw: string | undefined;
    try {
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = await promptWithFailoverAuto(judge, prompt, {
        signal: new AbortController().signal,
        manager: this.opts.manager,
        agentName: "swarm-read",
        describeError: describeSdkError,
      });
      raw = extractText(res) ?? "";
    } catch {
      return null;
    }
    if (!raw) return null;
    const validIds = streams.map((s) => s.id);
    const pick = parseCrossStreamPick(raw, validIds);
    return pick?.winnerStreamId ?? null;
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
    // T-Item-2 (2026-05-04): when a stream is supplied, scope the
    // prompt's transcript view to ONLY this stream's entries (each
    // stream debates a different proposition; cross-feeding their
    // transcripts would have PRO/CON arguing past each other).
    const transcriptView = stream
      ? [...stream.transcript]
      : [...this.transcript];
    const prompt = buildDebaterPrompt({
      side,
      round,
      totalRounds,
      proposition,
      isFinalRound,
      transcript: transcriptView,
      userDirective,
    });
    // Phase 2c: tag so VerdictPanel can group PRO/CON pairs by round.
    await this.runAgent(agent, prompt, { role: side, round }, undefined, "swarm-read", stream);
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
    userDirective?: string,
  ): Promise<void> {
    this.appendSystem(
      `Build phase: PRO will implement the next-action recommendation; CON reviews; JUDGE signs off.`,
      { kind: "next_action_phase", role: "announcement" },
    );

    // Implementer (PRO with write tools)
    if (this.stopping) return;
    const implPrompt = buildImplementerPrompt(proposition, verdict, userDirective);
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
    const reviewerPrompt = buildReviewerPrompt(proposition, verdict, [...this.transcript], userDirective);
    await this.runAgent(
      con,
      reviewerPrompt,
      undefined,
      () => ({ kind: "next_action_phase", role: "reviewer" }),
    );

    // Signoff (JUDGE, read-only)
    if (this.stopping) return;
    const signoffPrompt = buildSignoffPrompt(proposition, verdict, [...this.transcript], userDirective);
    await this.runAgent(
      judge,
      signoffPrompt,
      undefined,
      () => ({ kind: "next_action_phase", role: "signoff" }),
    );
  }

  // T199 (2026-05-04): rank N candidate propositions + return the
  // winning index. Judge fires one dedicated prompt that lists the
  // candidates + asks for the most informative pick + rationale.
  // Returns null on any failure (caller falls back to first-non-fallback).
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
    // T-Item-2 (2026-05-04): scope transcript view to this stream when
    // running a stream-local judge turn.
    const transcriptView = stream
      ? [...stream.transcript]
      : [...this.transcript];
    const prompt = buildJudgePrompt({ proposition, transcript: transcriptView, userDirective });
    // Task #81: try to parse the JUDGE response as a structured
    // verdict and upgrade the summary tag. Falls back to plain
    // debate_turn if JSON parse fails — the freeform text still
    // lands in the transcript.
    // Task #94: capture the parsed verdict so the loop can use
    // confidence:high as an early-stop signal.
    let parsed: ParsedDebateVerdict | null = null;
    await this.runAgent(
      judge,
      prompt,
      { role: "judge", round },
      (text) => {
        parsed = parseDebateVerdict(text);
        if (!parsed) return undefined;
        return { kind: "debate_verdict", round, ...parsed };
      },
      "swarm-read",
      stream,
    );
    if (parsed && stream) stream.verdict = parsed;
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
      const stripped = stripAgentText(text);
      const enriched = enrichSummary?.(stripped.finalText);
      // Phase 2 (writeMode: multi): collect hunk proposals if multi-writer active
      if (this.multiWriter?.isActive()) {
        const proposalResult = this.multiWriter.addProposal(agent, stripped.finalText);
        if (!proposalResult.skipped && proposalResult.hunks.length > 0) {
          this.appendSystem(
            `[${agent.id}] proposed ${proposalResult.hunks.length} hunk(s) — collected for reconciliation.`
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


