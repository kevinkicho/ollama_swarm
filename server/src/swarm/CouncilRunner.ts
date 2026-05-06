import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";

import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk, extractText } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

import { staggerStart } from "./staggerStart.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import {
  tallyVotes,
  buildVotePrompt,
  parseVoteResponse,
  type VoteRecord,
} from "./councilReconcile.js";
import { userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverable, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { deriveRubric, type DerivedRubric } from "./rubricPrePass.js";
import {
  buildCouncilPositionsSection,
  countPositionFlips,
} from "./councilPosition.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import { parseConvergenceSignal } from "./convergenceSignal.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import {
  buildCouncilSynthesisPrompt,
  buildCouncilPrompt,
} from "./councilPromptHelpers.js";

// Council / parallel drafts + reconcile.
// Round 1: every agent drafts independently. Each agent's prompt contains
// only the seed + any human-injected messages — NO peer drafts. Drafts are
// fanned out in parallel and only land in the shared transcript after the
// whole round has settled, so within Round 1 no agent can see what any other
// agent wrote. That independence is the whole point: same-model agents
// produce surprisingly different answers when they can't anchor on each
// other's output first.
//
// Round 2..N: everyone sees everyone's drafts (and any prior revisions) and
// revises. The reconcile step is whatever the agents converge to across
// later rounds — no vote, no explicit judge. Discussion-only, no file edits.
export class CouncilRunner extends DiscussionRunnerBase {
  private stats = new AgentStatsCollector();
  private derivedRubric: DerivedRubric | null = null;
  private multiWriter?: MultiWriterState;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.stats.reset();

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "council",
      roleResolver: () => "Drafter",
    });
    this.stats.registerAgents(ready);

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      this.multiWriter = new MultiWriterState({
        writeMode: cfg.writeMode,
        conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["council"],
        clonePath: destPath,
      });
      this.appendSystem(
        `Multi-writer mode enabled — agents will propose hunks during rounds, reconciled via ${cfg.conflictPolicy ?? "vote"} policy.`,
      );
    }

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // 2026-05-02 (quality lever #2): derive a per-run rubric from the
    // user directive BEFORE the main loop. Lead agent (index 1) does
    // the derivation; result is stored for the deliverable + critic
    // pass at run-end. Best-effort — failure falls back to DEFAULT_RUBRIC
    // so the loop always proceeds.
    const lead = ready[0];
    if (lead && cfg.userDirective) {
      this.appendSystem(`Deriving success rubric from directive (lever #2)…`);
      this.derivedRubric = await deriveRubric({
        agent: lead,
        manager: this.opts.manager,
        directive: cfg.userDirective,
      });
      this.appendSystem(
        `Rubric derived: ${this.derivedRubric.criteria.length} criteria, shape "${this.derivedRubric.deliverableShape}".`,
      );
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg);
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    // 2026-05-02 (council improvement #1): user directive surfaces
    // at the TOP of the seed when set. Council was already deriving
    // a rubric from cfg.userDirective at run-start (lever #2 of the
    // deliverables initiative) but the agents themselves were
    // directive-blind in their drafts. Now every drafter sees it.
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "Every drafter answers the directive above. Round 1 = independent drafts (peers hidden); Round 2+ = reveal and revise. Synthesis at the end consolidates into a single answer with a minority report when dissent persists.",
        ],
      }),
      "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
    ];
    // Task #72: structured payload so the web renders the seed
    // announce as a grid (definition list + collapsible top-level
    // file list) instead of the wall-of-text comma-separated line.
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      // Phase B (Task #99): single midpoint convergence check.
      // Mirrors #94's debate-judge midpoint pattern — one extra
      // synthesis call max, not per-round. Skip for tiny runs where
      // a midpoint check IS the loop end.
      const earlyCheckRound = cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;
      // Task #146: dead-loop guard (mirrors #144).
      // 2026-05-03 (Phase B): dead-loop guard extracted to shared class.
      const deadLoopGuard = new OutputEmptyDeadLoopGuard({
        roleLabel: "drafters",
        unit: "round",
      });

      // Task #124: snapshot lifetime tokens at run start; budget
      // checks compare delta vs cfg.tokenBudget.
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

        // Snapshot the transcript at round start. Every agent in this round
        // builds its prompt from this same snapshot, guaranteeing that within
        // a round no agent sees another agent's output — even if one agent's
        // session.prompt returns before another's. For Round 1, the snapshot
        // contains only system + user entries (no agent output exists yet).
        const snapshot: readonly TranscriptEntry[] = [...this.transcript];
        const agents = this.opts.manager.list();

        // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED. v4
        // battle test showed it doubled timeout count (12 vs v3's 6) and
        // retry count (8 vs 4) — the parallel warmup batch hit the same
        // cloud cold-start ceiling as the real batch it was meant to
        // protect. Serial spawn-warmup stays in start(); council relies
        // on that alone now.

        // Fan out: runTurn appends to this.transcript as each agent returns,
        // so the UI sees drafts populate in real time while the prompts above
        // were all built from the pre-round snapshot.
        // Task #53: stagger the N parallel session.prompt calls by ~150ms
        // per agent so they don't all hit the cloud at the same ms.
        // Log analysis 2026-04-24 confirmed Pattern 3 — agent-2 consistently
        // loses the queue race when all agents fire simultaneously.
        const transcriptLenBefore = this.transcript.length;
        await staggerStart(agents, (agent) =>
          this.runTurn(agent, r, cfg.rounds, snapshot, cfg.userDirective),
        );
        // Task #146: dead-loop guard. After each council round, if EVERY
        // drafter's new entry is empty/junk, count consecutive bad rounds
        // and break at threshold. Same context-bloat root cause as #144.
        // 2026-05-03 (Phase B): logic extracted to OutputEmptyDeadLoopGuard.
        const newEntries = this.transcript
          .slice(transcriptLenBefore)
          .filter((e) => e.role === "agent");
        const dlHit = deadLoopGuard.recordIteration(newEntries);
        if (dlHit.tripped) {
          this.earlyStopDetail = dlHit.earlyStopDetail;
          this.appendSystem(
            `All council drafters produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending council early.`,
          );
          break;
        }

        // T181 (2026-05-04): convergence-too-fast detector. After R2,
        // if EVERY drafter said KEEP (zero CHANGEs) the council
        // converged before exposing positions to dissent — that's
        // suspicious. Inject a system message that R3+ prompts will
        // see, requiring at least ONE agent to produce CHANGE based
        // on grounded re-examination. Soft signal — doesn't force
        // anyone, just shifts the prompt's framing toward dissent.
        if (r === 2 && r < cfg.rounds) {
          const flips = countPositionFlips(this.transcript, 2, cfg.agentCount);
          if (flips.changes === 0 && flips.keeps >= 2) {
            this.appendSystem(
              `[T181 contrarian round trigger] Round 2 had ${flips.keeps}× KEEP and 0× CHANGE — the council converged without anyone updating their position. Round ${r + 1}: at least ONE agent should produce a grounded CHANGE (cite evidence the team didn't engage with) OR explicitly justify why every position survived peer challenge unmodified. "Everyone politely converged" is the failure mode this guard exists to catch.`,
            );
          }
        }

        if (cfg.postRoundCritique) {
          await maybeRunPostRoundCritique({
            agents: this.opts.manager.list(),
            round: this.round,
            totalRounds: cfg.rounds,
            transcript: this.transcript,
            userDirective: cfg.userDirective,
            enabled: cfg.postRoundCritique ?? false,
            runDiscussionAgent: (agent, prompt, opts) => this.runDiscussionAgent(agent, prompt, opts),
            stats: this.stats,
            appendSystem: (text, summary) => this.appendSystem(text, summary),
            presetName: "council",
            stopping: this.stopping,
          });
        }

        // Phase B (Task #99): midpoint synthesis check. If the
        // synthesizer reports CONVERGENCE: high, the council has
        // settled — running more rounds just restates the same
        // consensus. The midpoint synthesis is the canonical
        // synthesis (we don't run it again at end), so skip the
        // post-loop pass.
        if (
          !this.stopping &&
          r === earlyCheckRound &&
          r < cfg.rounds
        ) {
          const convergence = await this.runSynthesisPass(cfg);
          if (convergence === "high") {
            this.earlyStopDetail =
              `council-converged-high after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `Council reached convergence:high at round ${r}/${cfg.rounds} — ending early.`,
            );
            break;
          }
        }
      }
      // Task #79 (2026-04-25): final consensus pass. After all rounds,
      // agent-1 takes every drafter's final position and produces a
      // single consolidated answer. Without this, council ends with N
      // parallel drafts and no clear "what did we decide" output —
      // users had to read every draft and synthesize themselves.
      // Task #99: skip if the midpoint check already broke us out
      // (in which case we already ran the synthesis above).
      if (!this.stopping && cfg.rounds > 0 && !this.earlyStopDetail) {
        await this.runSynthesisPass(cfg);
      }
      // T-Item-CouncilRec (2026-05-04): post-synthesis vote pass when
      // cfg.councilReconcile === "vote". Each drafter casts ONE vote
      // for the BEST OTHER agent's final draft; tally announced as a
      // system message. Doesn't replace the synthesis (which still
      // produces a consolidated answer); the vote is an additional
      // signal showing which drafter the council found most compelling.
      if (
        !this.stopping &&
        cfg.councilReconcile === "vote" &&
        cfg.rounds > 0
      ) {
        await this.runVoteReconcile(cfg);
      }
      // 2026-05-02 (deliverables initiative + quality levers): structured
      // markdown artifact + rubric + critic + next-actions. Best-effort —
      // never blocks run-end if it fails.
      if (!this.stopping && cfg.runId) {
        await this.writeCouncilDeliverable(cfg);
      }
      if (!this.stopping) this.appendSystem("Council complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
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
            `Council preset · ${cfg.agentCount} drafters · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
        transcript: this.transcript,
        emitOutcome: (outcome: any) => this.opts.emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions }),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
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

  // 2026-05-02 (deliverables initiative + quality levers #1-#3):
  // per-preset structured markdown artifact. Pulls the synthesis bubble
  // from the transcript (latest entry tagged council_synthesis) + the
  // per-round drafts and renders them as a portable report. Augmented
  // by runQualityPasses with a rubric (top), critic notes (bottom),
  // and extracted next-actions (bottom). Best-effort — failure posts
  // a system message but doesn't break run-end.
  private async writeCouncilDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective(cfg);
    // Latest synthesis bubble (lead's consolidated answer).
    const synthesisEntry = [...this.transcript]
      .reverse()
      .find((e) => e.summary?.kind === "council_synthesis");
    const synthesisText = synthesisEntry?.text ?? "_(synthesis missing)_";
    // Round 1 = independent drafts (peer-hidden). Group by agentIndex.
    const round1Drafts = this.transcript.filter(
      (e) =>
        e.summary?.kind === "council_draft" &&
        e.summary.round === 1 &&
        e.role === "agent",
    );
    // Final round = revised drafts. Last round number we actually ran.
    const finalRound = this.round;
    const finalDrafts = this.transcript.filter(
      (e) =>
        e.summary?.kind === "council_draft" &&
        e.summary.round === finalRound &&
        e.role === "agent",
    );
    // 2026-05-02 (council improvement #4): per-agent latest position
    // section, extracted from `### MY POSITION` blocks. Surfaces each
    // agent's final answer side-by-side with the synthesis — counters
    // synthesis-collapse by giving the reader the raw distinct
    // positions, not just the consolidated view.
    const positionsSection = buildCouncilPositionsSection(
      this.transcript,
      cfg.agentCount,
    );
    const baseSections: Array<{ title: string; body: string }> = [];
    const directiveSection = maybeDirectiveSection(dirCtx);
    if (directiveSection) baseSections.push(directiveSection);
    baseSections.push(
      {
        title: pickAnswerSectionTitle(dirCtx, {
          withDirective: "Answer to directive",
          withoutDirective: "Final synthesis",
        }),
        body: synthesisText,
      },
      positionsSection,
      {
        title: `Round ${finalRound} — final drafts (full text)`,
        body:
          finalDrafts.length > 0
            ? finalDrafts
                .map((e) => `### Agent ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
                .join("\n\n")
            : "_(no final-round drafts captured)_",
      },
      {
        title: "Round 1 — independent first drafts (peer-hidden)",
        body:
          round1Drafts.length > 0
            ? round1Drafts
                .map((e) => `### Agent ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
                .join("\n\n")
            : "_(no round 1 drafts captured)_",
      },
    );
    // 2026-05-02 (quality levers #1-#3): augment with rubric +
    // critic notes + extracted next-actions. The lead agent (index 1)
    // doubles as critic so we don't burn a separate agent slot.
    const lead = this.opts.manager.list().find((a) => a.index === 1) ?? null;
    const sections = await runQualityPasses({
      baseSections,
      rubric: this.derivedRubric,
      criticAgent: lead,
      manager: this.opts.manager,
    });
    const subtitleBase = `${cfg.agentCount} drafter${cfg.agentCount === 1 ? "" : "s"} across ${finalRound}/${cfg.rounds} round${cfg.rounds === 1 ? "" : "s"}${this.earlyStopDetail ? " · early-stop" : ""}`;
    const result = writeDeliverable({
      preset: "council",
      runId: cfg.runId,
      clonePath: cfg.localPath,
      title: pickDeliverableTitle(dirCtx, {
        withDirective: "Council: directive answer",
        withoutDirective: "Council synthesis",
      }),
      subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
      sections,
    });
    if (result.ok) {
      this.appendSystem(`Deliverable saved → ${result.filename}`, {
        kind: "deliverable",
        preset: "council",
        filename: result.filename,
        fullPath: result.fullPath,
        bytes: result.bytes,
        sectionTitles: sections.map((s) => s.title),
      });
    } else {
      this.appendSystem(`Failed to write deliverable (${result.reason})`);
    }

    // T2.2 (2026-05-04): opt-in wrap-up apply phase. When
    // cfg.executeNextAction is set, fire one worker prompt against the
    // top extracted next-action and apply hunks via the baseline path.
    // Council's lead (agent-1) doubles as the implementer here so we
    // don't need to spawn a new agent. Best-effort; any failure is
    // logged via appendSystem and doesn't block the rest of the
    // close-out.
    //
    // Phase 1 (writeMode: single): when cfg.writeMode === "single",
    // use the synthesizer-hunks path if discussionContext is available.
    // The synthesis pass already ran, so we construct the context from
    // the transcript.
    if (lead) {
      // Build discussion context for synthesizer-hunks path
      const synthesisEntry = this.transcript.find(
        (e) => e.summary?.kind === "council_synthesis",
      );
      const discussionContext = synthesisEntry
        ? [
            `Council synthesis after ${finalRound}/${cfg.rounds} round(s):`,
            synthesisEntry.text,
            "",
            "Key positions from agents:",
            ...this.transcript
              .filter((e) => e.role === "agent" && e.summary?.kind !== "council_synthesis")
              .slice(-cfg.agentCount * 2) // last ~2 rounds per agent
              .map((e) => `[Agent ${e.agentIndex ?? "?"}] ${e.text.slice(0, 500)}…`),
          ].join("\n")
        : undefined;

      // Extract relevant files from the transcript (grounding citations)
      const relevantFiles: string[] = [];
      const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
      for (const e of this.transcript) {
        if (e.role !== "agent") continue;
        const matches = e.text.match(filePattern) || [];
        for (const m of matches) {
          if (!relevantFiles.includes(m)) relevantFiles.push(m);
        }
      }

      await maybeRunWrapUpApply({
        cfg,
        presetName: "council",
        agent: lead,
        manager: this.opts.manager,
        repos: this.opts.repos,
        emit: this.opts.emit,
        appendSystem: (text) => this.appendSystem(text),
        discussionContext,
        relevantFiles: relevantFiles.slice(0, 20), // cap at 20 files
      });
    }

    // Phase 2 (writeMode: multi): reconcile proposals if multi-writer active
    if (this.multiWriter?.isActive() && this.multiWriter.proposalCount() > 0) {
      const proposals = this.multiWriter.getProposals();
      this.appendSystem(
        `Multi-writer reconcile: ${proposals.length} proposal(s) from ${new Set(proposals.map(p => p.agentId)).size} agent(s).`,
      );

      const currentFiles: Record<string, string | null> = {};
      const allFiles = new Set(proposals.flatMap(p => p.hunks.map(h => h.file)));
      for (const file of allFiles) {
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const absPath = path.join(cfg.localPath, file);
          currentFiles[file] = await fs.readFile(absPath, "utf8");
        } catch {
          currentFiles[file] = null;
        }
      }

      const strategy = cfg.conflictPolicy ?? "vote";
      const result = await this.multiWriter.reconcile(currentFiles, strategy);

      if (!result.ok) {
        this.appendSystem(
          `Multi-writer reconcile: failed — ${result.conflicts.length} conflict(s) detected.`,
        );
        for (const conflict of result.conflicts.slice(0, 5)) {
          this.appendSystem(
            `  ${conflict.type} on ${conflict.file}: ${conflict.conflictingAgents.map(a => `agent-${a.agentIndex}`).join(", ")}`,
          );
        }
      } else if (result.hunks.length > 0) {
        this.appendSystem(
          `Multi-writer reconcile: ${result.hunks.length} hunk(s) ready to apply (${strategy} strategy).`,
        );

        // Apply reconciled hunks via wrapUpApplyPhase
        const { runWrapUpApplyPhase } = await import("./wrapUpApplyPhase.js");
        const applyResult = await runWrapUpApplyPhase({
          directive: cfg.userDirective ?? "Council multi-writer synthesis",
          clonePath: cfg.localPath,
          model: cfg.writeModel ?? cfg.model,
          agent: lead!,
          repos: this.opts.repos,
          manager: this.opts.manager,
          emit: this.opts.emit,
          appendSystem: (text) => this.appendSystem(text),
          presetName: "council",
          verifyCommand: cfg.verifyCommand,
          hunksFromSynthesizer: result.hunks,
        });

        if (applyResult.ok) {
          this.appendSystem(
            `Multi-writer apply: ${applyResult.hunksApplied}/${applyResult.hunksAttempted} hunk(s) committed (${applyResult.commitSha?.slice(0, 7)}).`,
          );
        } else {
          this.appendSystem(
            `Multi-writer apply: failed — ${applyResult.reason}`,
          );
        }
      } else {
        this.appendSystem(`Multi-writer reconcile: 0 hunks to apply.`);
      }
    }
  }

  // Task #79: final consensus synthesis. Routes through agent-1 with
  // all council drafts in context and asks for a unified answer. Uses
  // the same promptWithRetry + extractText path as runTurn so timing
  // + retry stats land in the per-agent rollup. Treated as a normal
  // agent turn for stats purposes — the synthesis IS agent-1's last
  // contribution. Tagged with summary kind "council_synthesis" so
  // the modal can render it distinctively.
  private async runSynthesisPass(cfg: RunConfig): Promise<"high" | "medium" | "low" | null> {
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
    this.appendSystem(`Synthesizing council consensus (agent-${lead.index})…`);

    const prompt = buildCouncilSynthesisPrompt(cfg.rounds, this.transcript, cfg.userDirective);
    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      const onTokens = ({ promptTokens, responseTokens }: { promptTokens: number; responseTokens: number }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens);
      const res = await promptWithFailoverAuto(lead, prompt, {
        onTokens,
        signal: controller.signal,
        manager: this.opts.manager,
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(cfg.topology, lead.index),
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
        runner: "council",
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
      // Task #108: defensive guard — if the post-retry text still
      // looks like junk, do NOT tag it as the canonical synthesis.
      // The transcript still keeps the entry (so the run history
      // shows what happened) but without the synthesis kind, the
      // UI won't render a single character as the "consensus".
      const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
      if (cfg.postSynthesisCritique && !isJunkSynthesis && text.length > 0) {
        const proposals = this.transcript
          .filter(e => e.role === "agent")
          .slice(-this.opts.manager.list().length)
          .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
        const criticAgent = this.opts.manager.list()[0] ?? lead;
        const revised = await runPostSynthesisCritique({
          synthesis: text,
          proposals,
          criticAgent,
          manager: this.opts.manager,
          appendSystem: (txt) => this.appendSystem(txt),
          stopping: this.stopping,
          runDiscussionAgent: (agent, pr, opts) => this.runDiscussionAgent(agent, pr, opts),
          stats: this.stats,
          presetName: "council",
        });
        text = revised;
      }
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
          : { kind: "council_synthesis", rounds: cfg.rounds },
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      if (isJunkSynthesis) {
        this.appendSystem(
          `[${lead.id}] synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
        );
        return null;
      }
      // Phase B (Task #99): parse the convergence signal so the loop
      // can act on it.
      return parseConvergenceSignal(text);
    } catch (err) {
      // Synthesis failure is non-fatal — log and continue. The council
      // still produced N final drafts that the user can read.
      this.appendSystem(
        `[${lead.id}] synthesis failed (${err instanceof Error ? err.message : String(err)}); skipping consolidation.`,
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

  // T-Item-CouncilRec (2026-05-04): vote reconcile pass. After the
  // synthesis, fire ONE small prompt per drafter asking them to vote
  // for the BEST OTHER agent's final draft. Tally + announce.
  // Best-effort: any per-drafter failure counts as an abstention; the
  // final tally still reports.
  private async runVoteReconcile(cfg: RunConfig): Promise<void> {
    const agents = this.opts.manager.list();
    if (agents.length < 2) return;
    // Collect each agent's FINAL-round draft (latest agent entry per
    // agentIndex). The synthesis bubble is also a "final" entry but
    // it's the lead's; for vote we only count the per-round drafts.
    const finalDrafts = new Map<number, string>();
    for (const e of this.transcript) {
      if (e.role !== "agent") continue;
      if (e.summary?.kind === "council_synthesis") continue;
      if (typeof e.agentIndex === "number") {
        finalDrafts.set(e.agentIndex, e.text);
      }
    }
    const draftList = [...finalDrafts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([agentIndex, text]) => ({ agentIndex, text }));
    if (draftList.length < 2) return;
    this.appendSystem(
      `[T-Item-CouncilRec vote] reconcile phase: each drafter casts ONE vote for the best OTHER draft.`,
    );
    const validAgentIndexes = draftList.map((d) => d.agentIndex);
    const votes: VoteRecord[] = [];
    for (const agent of agents) {
      if (!validAgentIndexes.includes(agent.index)) continue;
      const prompt = buildVotePrompt({
        voterIndex: agent.index,
        drafts: draftList,
        userDirective: cfg.userDirective,
      });
      const ctrl = new AbortController();
      try {
        const res = await promptWithFailoverAuto(agent, prompt, {
          signal: ctrl.signal,
          manager: this.opts.manager,
          agentName: "swarm-read",
          describeError: describeSdkError,
        });
        const raw = extractText(res) ?? "";
        const parsed = parseVoteResponse(raw, agent.index);
        votes.push({
          voterIndex: agent.index,
          votedForIndex: parsed.votedForIndex,
          rationale: parsed.rationale,
        });
      } catch {
        votes.push({
          voterIndex: agent.index,
          votedForIndex: null,
          rationale: "",
        });
      }
    }
    const tally = tallyVotes(votes, validAgentIndexes);
    const tallyLines = [...tally.countsByIndex.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([idx, count]) => `  Agent ${idx}: ${count} vote(s)`);
    const winnerLine =
      tally.winnerIndex !== null
        ? `Winner: Agent ${tally.winnerIndex} (${tally.countsByIndex.get(tally.winnerIndex)} vote(s)).`
        : `No clear winner — all ${tally.abstentions} ballots abstained.`;
    this.appendSystem(
      `[T-Item-CouncilRec vote] tally:\n${tallyLines.join("\n")}\n${winnerLine}`,
    );
  }

  private async runTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    const visible = snapshot.filter((e) => userEntryVisibleTo(e, agent.id));
    const prompt = buildCouncilPrompt(agent.index, round, totalRounds, visible, userDirective);
    await this.runDiscussionAgent(agent, prompt, {
      runnerName: "council",
      agentName: "swarm-read",
      stats: this.stats,
      enrichSummary: {
        kind: "council_draft",
        round,
        phase: round === 1 ? "draft" : "reveal",
      },
      onEntryPushed: (_entry, strippedText) => {
        if (this.multiWriter?.isActive()) {
          const result = this.multiWriter.addProposal(agent, strippedText);
          if (!result.skipped && result.hunks.length > 0) {
            this.appendSystem(
              `[${agent.id}] proposed ${result.hunks.length} hunk(s) — collected for reconciliation.`,
            );
          }
        }
      },
    });
  }

}

// Re-exports for backward compat with external callers (tests, etc.)
// that import these from this module.
export { parseConvergenceSignal as parseCouncilConvergence } from "./convergenceSignal.js";
export { buildCouncilPrompt, buildCouncilSynthesisPrompt } from "./councilPromptHelpers.js";

