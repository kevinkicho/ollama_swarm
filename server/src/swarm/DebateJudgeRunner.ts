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
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractText } from "./extractText.js";
import { formatChatReceipt } from "./chatReceipt.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { repairAndParseJson } from "./repairJson.js";
import { formatCloneMessage } from "./cloneMessage.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { deriveProposition, type DerivedProposition } from "./propositionDerive.js";
import { DebateStream } from "./DebateStream.js";
import {
  readDirective,
  buildDirectiveBlock,
  buildInlineDirectiveBlock,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";

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
  // 2026-05-03 (debate-judge improvement #1): when the user gives a
  // directive but no proposition, the judge agent auto-derives a sharp
  // PRO/CON proposition at run start. Stored so the seed can label
  // whether the proposition was derived vs. user-supplied vs. fallback.
  private derivedPropositionMeta: DerivedProposition | null = null;
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
    // If the run hasn't started yet (phase is idle), treat the most recent
    // user input as the proposition override. Once the run is underway,
    // injectUser just posts to the transcript as normal.
    if (this.phase === "idle" && text.trim().length > 0) {
      this.proposition = text.trim();
    }
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
      });
    }
  }

  // 2026-05-02 (deliverables initiative): debate-judge structured
  // artifact. Pulls verdict + per-side arguments from the transcript
  // (kind: "debate_verdict" + "debate_turn"). Best-effort.
  private async writeDebateDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective(cfg);
    const proTurns = this.transcript.filter(
      (e) => e.summary?.kind === "debate_turn" && e.summary.role === "pro",
    );
    const conTurns = this.transcript.filter(
      (e) => e.summary?.kind === "debate_turn" && e.summary.role === "con",
    );
    const verdictEntry = [...this.transcript]
      .reverse()
      .find((e) => e.summary?.kind === "debate_verdict");
    const verdict = verdictEntry?.summary?.kind === "debate_verdict" ? verdictEntry.summary : null;
    // 2026-05-03 (debate-judge improvement #3): Directive section above
    // Proposition when set; proposition section labels source (user-set,
    // auto-derived, or fallback) so the reader knows where it came from.
    const sections: Array<{ title: string; body: string }> = [];
    const directiveSection = maybeDirectiveSection(dirCtx);
    if (directiveSection) sections.push(directiveSection);
    const propositionLabel = this.derivedPropositionMeta
      ? this.derivedPropositionMeta.derived
        ? "Proposition (auto-derived from directive)"
        : "Proposition (fallback — auto-derive failed)"
      : "Proposition";
    sections.push(
      {
        title: propositionLabel,
        body: this.proposition?.trim() || dirCtx.directive || "_(no proposition)_",
      },
      {
        title: "Judge verdict",
        body: verdict
          ? `**Winner: ${verdict.winner.toUpperCase()}** · confidence ${verdict.confidence}\n\n` +
            `- PRO strongest: ${verdict.proStrongest}\n` +
            `- CON strongest: ${verdict.conStrongest}\n` +
            `- Decisive: ${verdict.decisive}\n` +
            `- Next action: ${verdict.nextAction}`
          : "_(no verdict captured)_",
      },
    );
    // T176 (2026-05-04): loser-perspective preservation. When PRO or
    // CON wins decisively, the loser's strongest argument shouldn't
    // just disappear — it's a real risk the implementer should know
    // about going in. Surface it as "Known risks" so the next-action
    // is implemented WITH eyes open, not despite the dissent.
    if (verdict && verdict.winner !== "tie") {
      const loserSide = verdict.winner === "pro" ? "CON" : "PRO";
      const loserStrongest =
        verdict.winner === "pro" ? verdict.conStrongest : verdict.proStrongest;
      const trimmed = loserStrongest?.trim() ?? "";
      sections.push({
        title: "Known risks (preserved from the losing side)",
        body:
          trimmed.length > 0
            ? `Even though ${verdict.winner.toUpperCase()} won, ${loserSide}'s strongest argument identified a real concern that the implementer should keep in mind:\n\n> ${trimmed}\n\nIf you act on the verdict's nextAction, do so with this objection consciously addressed — not dismissed.`
            : `_(${loserSide}'s strongest argument was empty; no preserved risk to surface.)_`,
      });
    }
    sections.push(
      {
        title: `PRO arguments (${proTurns.length} round${proTurns.length === 1 ? "" : "s"})`,
        body: proTurns.length > 0
          ? proTurns.map((e, i) => `### Round ${i + 1}\n\n${e.text.trim()}`).join("\n\n")
          : "_(no PRO turns)_",
      },
      {
        title: `CON arguments (${conTurns.length} round${conTurns.length === 1 ? "" : "s"})`,
        body: conTurns.length > 0
          ? conTurns.map((e, i) => `### Round ${i + 1}\n\n${e.text.trim()}`).join("\n\n")
          : "_(no CON turns)_",
      },
    );
    // 2026-05-02 (quality levers #1+#3): augment with critic +
    // next-actions. Judge agent (last, index 3) doubles as critic.
    const judge = this.opts.manager.list().find((a) => a.index === 3) ?? null;
    const augmented = await runQualityPasses({
      baseSections: sections,
      rubric: null,
      criticAgent: judge,
      manager: this.opts.manager,
    });
    const subtitleBase = `${proTurns.length} PRO + ${conTurns.length} CON rounds${this.earlyStopDetail ? " · early-stop" : ""}`;
    writeDeliverableAndEmit(
      {
        preset: "debate-judge",
        runId: cfg.runId,
        clonePath: cfg.localPath,
        title: pickDeliverableTitle(dirCtx, {
          withDirective: "Debate-judge: directive decision",
          withoutDirective: "Debate verdict",
        }),
        subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
        sections: augmented,
      },
      { transcript: this.transcript, emit: this.opts.emit },
    );

    // T176 (2026-05-04): verifiable nextAction. Debate-judge has had a
    // legacy "build phase" (Task #102 implementer/reviewer/signoff)
    // that runs under the `swarm` profile (which denies all tools), so
    // its "implementation" is prose-only — no actual file edits land.
    // Wire the canonical wrap-up apply phase from T2.x alongside, so
    // when cfg.executeNextAction is set the verdict's nextAction
    // ACTUALLY becomes a commit (with cfg.verifyCommand gating it).
    // The legacy phase still runs first; the apply phase runs after
    // the deliverable lands and uses the verdict's nextAction (or top
    // extracted action from next-actions.json) as the directive.
    if (judge) {
      await maybeRunWrapUpApply({
        cfg,
        presetName: "debate-judge",
        agent: judge,
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
    if (propositions.length === 0) return null;
    if (propositions.length === 1) return 0;
    const prompt = [
      "You are the JUDGE picking the most INFORMATIVE proposition to debate.",
      "",
      `User directive (the work this debate informs): ${directive}`,
      "",
      `Candidate propositions (${propositions.length}):`,
      ...propositions.map((p, i) => `  [${i}] ${p}`),
      "",
      "Pick the ONE that maximizes:",
      "1. Debatable surface area (genuinely two-sided, not a foregone conclusion)",
      "2. Grounded in the directive's real concerns (not tangential)",
      "3. Non-trivial framing (\"X is good\" with no qualifier is too vague; \"X is the right tradeoff under constraint Y\" is strong)",
      "",
      "Output STRICT JSON only — no prose, no markdown fences:",
      '{"pickedIndex": <0-based integer>, "rationale": "<one-sentence why this is the most informative debate frame>"}',
    ].join("\n");
    let raw: string;
    try {
      const ctrl = new AbortController();
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const result = promptWithFailoverAuto(
        judge,
        prompt,
        {
          signal: ctrl.signal,
          manager: this.opts.manager,
          agentName: "swarm-read",
          describeError: (e) => describeSdkError(e),
        },
      );
      const settled = (await result) as { data?: { parts?: Array<{ type: string; text: string }> } };
      raw = settled.data?.parts?.find((p) => p.type === "text")?.text ?? "";
    } catch {
      return null;
    }
    if (!raw || raw.trim().length === 0) return null;
    const text = (extractText(raw) ?? raw).trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate = fenceMatch ? fenceMatch[1] : text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      const braceMatch = candidate.match(/\{[\s\S]*\}/);
      if (!braceMatch) return null;
      try {
        parsed = JSON.parse(braceMatch[0]);
      } catch {
        return null;
      }
    }
    if (!parsed || typeof parsed !== "object") return null;
    const idx = (parsed as { pickedIndex?: unknown }).pickedIndex;
    if (typeof idx !== "number" || !Number.isInteger(idx)) return null;
    if (idx < 0 || idx >= propositions.length) return null;
    return idx;
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
  userDirective?: string;
}

export function buildDebaterPrompt(args: BuildDebaterPromptArgs): string {
  const { side, round, totalRounds, proposition, isFinalRound, transcript, userDirective } = args;
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

  // 2026-05-03 (debate-judge improvement #2): broader directive context.
  // The proposition is what PRO/CON debate; the directive is the
  // broader work. Knowing the directive helps debaters frame arguments
  // around real consequences ("if we go the bcrypt-big-PR route,
  // <directive> will / won't be unblocked because…") rather than
  // arguing the proposition in a vacuum.
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work this debate informs",
    followUpLines: [
      "Your arguments should consider how the proposition affects the broader directive — but stay focused on debating THE PROPOSITION specifically.",
    ],
  });

  return [
    `You are Agent ${agentIndex}, the ${role} debater in a structured debate.`,
    `Proposition: "${proposition}"`,
    `Your job: argue ${stance} the proposition.`,
    ...directiveBlock,
    roundBrief,
    "",
    "Your working directory IS the project clone — you may use file-read, grep, and find-files tools to gather evidence for your position.",
    "Keep responses under ~300 words. Cite file paths (e.g. `src/foo.ts:42`) where relevant — concrete evidence beats abstract argument.",
    "Do NOT flip sides. Do NOT concede the proposition — your role is adversarial. If the evidence genuinely contradicts your side, find a narrower framing that's still defensible.",
    "",
    // T184 (2026-05-04): opposing-evidence requirement. Forces the
    // debate onto real codebase facts rather than abstract argument.
    // Each turn must include a "## Evidence" sub-block with at least
    // ONE specific citation — file path / test name / commit SHA /
    // measurement — that supports the side. Pure abstract debaters
    // get re-prompted.
    "**EVIDENCE BLOCK (required every turn):** Include a section labeled `## Evidence` with at least ONE concrete citation supporting your position this turn. Format:",
    "    ## Evidence",
    "    - <file path or test name or commit SHA>: <one-line why it supports your stance>",
    "    - (optionally more)",
    "Citations must be real (verified via tools) — fabricating evidence to seem grounded is worse than abstract argument. If after honest investigation you can't find any, write `## Evidence\\n_No specific evidence found this turn — argument rests on general principles X, Y._` and explain.",
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
  userDirective?: string;
}

export function buildJudgePrompt(args: BuildJudgePromptArgs): string {
  const { proposition, transcript, userDirective } = args;
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  // 2026-05-03 (debate-judge improvement #2): directive context for
  // the judge. The verdict's nextAction should advance the broader
  // directive when set — not just a generic "next thing to do" given
  // the proposition. Implementer's write-tools turn will action it.
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "what the implementer's nextAction should target",
    followUpLines: [
      "When you fill in `nextAction`, frame it as the concrete next step toward the directive informed by the debate's verdict — not a generic 'consider X' suggestion.",
    ],
  });

  // Task #81 (2026-04-25): structured verdict. Previously freeform
  // text; now JSON envelope so the modal renders a scorecard.
  // Parser is lenient — falls back to freeform-as-rationale if model
  // doesn't comply with JSON shape.
  return [
    "You are Agent 3, the JUDGE of a structured debate.",
    `Proposition: "${proposition}"`,
    ...directiveBlock,
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
  userDirective?: string,
): string {
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work this next-action targets",
    followUpLines: [
      "Your file edits should be a concrete step toward the directive, informed by the debate's verdict.",
    ],
  });
  return [
    `You are now the IMPLEMENTER (formerly PRO debater). The debate concluded with the JUDGE recommending a concrete next action — your job is to action it on the codebase.`,
    `Original proposition: "${proposition}"`,
    `Verdict winner: ${verdict.winner.toUpperCase()} · confidence: ${verdict.confidence}`,
    ...directiveBlock,
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
  userDirective?: string,
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
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work the implementer's edits should advance",
    followUpLines: [
      "Verify not just that the implementer's changes match the next-action, but that they meaningfully advance the directive — flag if the changes only superficially address it.",
    ],
  });
  return [
    `You are now the REVIEWER (formerly CON debater). The IMPLEMENTER just made changes to the codebase to action the JUDGE's next-action recommendation.`,
    `Original proposition: "${proposition}"`,
    `Verdict next-action: ${verdict.nextAction}`,
    ...directiveBlock,
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
  userDirective?: string,
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
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work the implementation should advance",
    followUpLines: [
      "When deciding ACCEPTED / PARTIAL / REJECTED, factor in whether the implementation meaningfully advances the directive — not just whether it actions the verdict's next-action in isolation.",
    ],
  });
  return [
    `You are still the JUDGE. The IMPLEMENTER actioned your next-action recommendation; the REVIEWER inspected the changes. Now you sign off.`,
    `Original proposition: "${proposition}"`,
    `Verdict next-action: ${verdict.nextAction}`,
    ...directiveBlock,
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

// Task #81: lenient parser for the JUDGE's JSON verdict. 2026-05-04
// (R11 wiring): the local three-strategy parser was replaced by
// repairAndParseJson, which adds soft repairs (trailing comma, smart
// quotes, missing braces) on top of the strict / fence / slice paths.
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
  const obj = repairAndParseJson(raw)?.value;
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
// 2026-05-04 (R11 wiring): parseLooseJson removed — see repairJson.ts.

// T-Item-2 (2026-05-04): cross-stream judge synthesis. After K parallel
// debate streams settle (each with a per-stream verdict), the JUDGE
// fires ONE prompt that compares all K verdicts and picks the most
// informative one as the canonical run-level verdict.
//
// "Most informative" = strongest grounding, clearest decision-relevant
// tradeoff, sharpest nextAction. Self-evaluation bias is acknowledged
// (the judge wrote the per-stream verdicts AND picks among them) — same
// pattern as T199's parallel-proposition rank step.

export interface CrossStreamPick {
  /** The stream id that won (e.g. "stream-2"). */
  winnerStreamId: string;
  /** One sentence on why this verdict is the most informative. */
  rationale: string;
}

export interface CrossStreamJudgeStreamSummary {
  id: string;
  proposition: string;
  verdict: ParsedDebateVerdict | null;
}

export function buildCrossStreamJudgePrompt(args: {
  streams: readonly CrossStreamJudgeStreamSummary[];
  userDirective?: string;
}): string {
  const { streams, userDirective } = args;
  const directiveBlock = buildInlineDirectiveBlock(
    readDirective({ userDirective }),
    {
      contextLabel: "the work the canonical verdict's nextAction should target",
      followUpLines: [
        "Pick the verdict whose nextAction most concretely advances the directive — not the one that's most rhetorically clever.",
      ],
    },
  );
  const streamBlocks = streams.map((s) => {
    if (!s.verdict) {
      return [
        `=== STREAM ${s.id} ===`,
        `Proposition: "${s.proposition}"`,
        `Verdict: (none — stream did not settle)`,
        "=== END ===",
      ].join("\n");
    }
    const v = s.verdict;
    return [
      `=== STREAM ${s.id} ===`,
      `Proposition: "${s.proposition}"`,
      `Winner: ${v.winner.toUpperCase()} · confidence ${v.confidence}`,
      `PRO strongest: ${v.proStrongest}`,
      `CON strongest: ${v.conStrongest}`,
      `Decisive: ${v.decisive}`,
      `Next action: ${v.nextAction}`,
      "=== END ===",
    ].join("\n");
  });
  return [
    "You are the JUDGE synthesizing across K PARALLEL debate streams.",
    "Each stream debated a DIFFERENT proposition derived from the user directive. You issued a verdict for each.",
    ...directiveBlock,
    "Now pick the ONE stream whose verdict is the MOST INFORMATIVE — strongest grounding in concrete evidence, clearest decision-relevant tradeoff, sharpest actionable nextAction.",
    "",
    "Streams:",
    ...streamBlocks,
    "",
    "Output STRICT JSON only — no prose, no markdown fences:",
    '{"winnerStreamId": "<the id of the winning stream, e.g. stream-2>", "rationale": "<one sentence — why this verdict is most informative>"}',
  ].join("\n");
}

export function parseCrossStreamPick(
  raw: string,
  validIds: readonly string[],
): CrossStreamPick | null {
  const obj = repairAndParseJson(raw)?.value;
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const winnerStreamId =
    typeof o.winnerStreamId === "string" ? o.winnerStreamId.trim() : null;
  if (!winnerStreamId) return null;
  if (validIds.length > 0 && !validIds.includes(winnerStreamId)) return null;
  const rationale =
    typeof o.rationale === "string" ? o.rationale.trim() : "";
  return { winnerStreamId, rationale };
}


