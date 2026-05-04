// #88 (2026-05-01): Mixture of Agents (MoA) preset.
//
// Together AI's research pattern (Wang et al.). Two layers per round:
//   Layer 1 (proposers): N agents each respond to the same seed in
//     parallel. Each proposer's prompt is peer-hidden — no agent sees
//     any other agent's draft. The independence is the whole point.
//   Layer 2 (aggregator): one agent synthesizes all N proposals into a
//     single coherent answer, optionally citing where they agreed /
//     disagreed.
//
// MoA reproducibly beats single-large-model on reasoning benchmarks
// using only small open-weights models — exactly this project's value
// prop ("N small models > 1 big model"). Discussion-only; no file
// edits.
//
// Differs from CouncilRunner: council does multi-round REVISION (peer-
// hidden round 1 → peer-visible round 2..N where each agent sees and
// revises its own draft). MoA does explicit AGGREGATION (peer-hidden
// proposers → dedicated aggregator that synthesizes). Both share the
// "round 1 = peer-hidden parallel drafts" idea; MoA's edge is the
// aggregator's framing of "find what these N agree on, drop what only
// one said."
//
// Multi-round: round R's aggregator output becomes round R+1's seed
// addition, so each round's proposers see the prior synthesis. Stops
// at `rounds` iterations.

import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type {
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { extractText } from "./extractText.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { describeSdkError } from "./sdkError.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import {
  detectConvergence,
  pickMostCentralAggregator,
  thresholdForDeliverableShape,
  scoreChallengerSubstantiveness,
} from "./moaConsensus.js";
import { detectSemanticConvergence, jaccardToCosineThreshold } from "./semanticConvergence.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { gatherProposerContext, type FileExcerpt } from "./moaContextGather.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverable, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { deriveRubric, recommendProposerCount, type DerivedRubric } from "./rubricPrePass.js";

export class MoaRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private startedAt?: number;
  // 2026-05-01: gates writeSummary so it fires exactly once per run even
  // if the loop exits via multiple paths (early return + finally).
  private summaryWritten = false;
  // Captured by writeSummary; undefined when run ended by exception.
  private actualRoundsCompleted = 0;
  // 2026-05-02 (quality lever #2): rubric derived at run-start; used
  // by writeMoaDeliverable for the Success-criteria section + critic
  // pass.
  private derivedRubric: DerivedRubric | null = null;
  // 2026-05-03 (post-Phase-D follow-up): natural-stop detail when the
  // budget/quota guard or another early-stop signal trips. Promoted to
  // stopReason="early-stop" by writeSummary. Matches the field used by
  // every other runner (audit Pattern 1 — MoA was the lone holdout).
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
    // 2026-05-02 (lever #1): synthetic system receipt so the user sees
    // their message landed AND knows how it'll affect the run. No LLM
    // call — pure deterministic explanation. Closes the "did anyone
    // hear me" gap.
    this.appendSystem(formatChatReceipt(intent, opts?.targetAgent));
  }

  isRunning(): boolean {
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.actualRoundsCompleted = 0;
    this.earlyStopDetail = undefined;

    void this.loop(cfg).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`MoA crashed: ${msg}`);
      this.setPhase("failed");
    });
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await this.loopBody(cfg);
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-01: every other discussion runner writes summary.json at
      // run termination via try/finally; MoA was missing this entirely,
      // which made every MoA attempt's summary.json read the previous
      // run's data (eval harness pulled stale council seed3 data for
      // every moa attempt during the first sweep 2 run). Mirror the
      // CouncilRunner pattern to fix.
      // 2026-05-02 (deliverables initiative + quality levers): structured
      // markdown + rubric + critic + next-actions before writeSummary so
      // the file lands even when the summary path errors. Best-effort.
      if (!this.stopping && cfg.runId && this.actualRoundsCompleted > 0) {
        await this.writeMoaDeliverable(cfg);
      }
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // MoA opts out of: reflection (no preset-specific lesson template
      // wired up — pickReflectionAgent returns null) AND uses a custom
      // shouldSetCompleted guard so a phase=failed inline-set inside
      // the loop body isn't overwritten by setPhase("completed").
      await runDiscussionCloseOut({
        cfg,
        crashMessage,
        stopping: this.stopping,
        round: this.round,
        currentPhase: this.phase,
        manager: this.opts.manager,
        appendSystem: (text) => this.appendSystem(text),
        setPhase: (p) => this.setPhase(p),
        writeSummary: () => this.writeSummary(cfg, crashMessage),
        hooks: {
          // null = MoA-style opt-out (no reflection)
          pickReflectionAgent: () => null,
          shouldSetCompleted: (current) => current !== "failed",
        },
      });
    }
  }

  private async loopBody(cfg: RunConfig): Promise<void> {
    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    const { destPath } = cloneResult;
    this.opts.emit({
      type: "clone_state",
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    });
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    this.appendSystem(`Cloned ${cfg.repoUrl} → ${destPath}`);
    if (this.stopping) return;

    this.setPhase("spawning");
    // Spawn N proposers + K aggregators. Aggregators are the LAST K
    // agents (highest indices). #93 deeper (2026-05-01): K configurable
    // via cfg.moaAggregatorCount (default 1, capped at 3). agentCount
    // covers proposers; aggregators are in ADDITION.
    //
    // #98 (2026-05-01): heterogeneous models per layer. Proposers use
    // cfg.moaProposerModel (defaults to cfg.model — e.g. gemma4 for
    // cheap fast drafts), aggregators use cfg.moaAggregatorModel
    // (defaults to cfg.model — e.g. nemotron / sonnet for synthesis).
    // Setting both to cfg.model preserves homogeneous-model behavior
    // for back-compat.
    const proposerCount = cfg.agentCount;
    const aggregatorCount = Math.max(1, Math.min(3, cfg.moaAggregatorCount ?? 1));
    const totalAgents = proposerCount + aggregatorCount;
    // T196 (2026-05-04): heterogeneous proposer cycling. When
    // cfg.moaProposerModels is set (array), each proposer N uses
    // moaProposerModels[(N-1) % length]. Falls back to single
    // moaProposerModel → cfg.model. Plays to MoA's actual value
    // prop: N DIFFERENT small models > N copies of one model.
    const proposerModels: readonly string[] =
      cfg.moaProposerModels && cfg.moaProposerModels.length > 0
        ? cfg.moaProposerModels
        : [cfg.moaProposerModel ?? cfg.model];
    const proposerModel = proposerModels[0]!; // for the heterogeneous flag below
    const aggregatorModel = cfg.moaAggregatorModel ?? cfg.model;
    const agents: Agent[] = [];
    for (let i = 1; i <= totalAgents; i++) {
      const isAggregator = i > proposerCount;
      const model = isAggregator
        ? aggregatorModel
        : proposerModels[(i - 1) % proposerModels.length]!;
      const agent = await this.opts.manager.spawnAgentNoOpencode({
        cwd: destPath,
        index: i,
        model,
      });
      agents.push(agent);
      if (this.stopping) return;
    }
    const proposers = agents.slice(0, proposerCount);
    const aggregators = agents.slice(proposerCount);
    const heterogeneous = proposerModel !== aggregatorModel;
    this.appendSystem(
      heterogeneous
        ? `MoA ready (heterogeneous): ${proposerCount} proposer(s) on ${proposerModel} + ${aggregatorCount} aggregator(s) on ${aggregatorModel} (${aggregators.map((a) => a.id).join(", ")})`
        : `MoA ready: ${proposerCount} proposer(s) + ${aggregatorCount} aggregator(s) (${aggregators.map((a) => a.id).join(", ")}) — single model: ${cfg.model}`,
    );
    if (proposerCount >= 2) {
      this.appendSystem(
        `[matrix #2] Designating ${proposers[proposers.length - 1].id} as CHALLENGER — red-team prompt to prevent consensus flattening.`,
      );
    }

    const directive = (cfg.userDirective ?? "").trim();
    const seed = directive.length > 0
      ? `User directive: ${directive}`
      : "No user directive supplied. Discuss the most useful thing to do with this codebase.";

    const repoFiles = await this.opts.repos.listRepoFiles(destPath, { maxFiles: 50 });
    const readme = await this.opts.repos.readReadme(destPath);

    // 2026-05-02 (lever #1): retrieval-augmented context. Pre-fetched
    // ONCE per run (not per round) so the operational cost is bounded;
    // a future iteration could re-gather per round if user nudges
    // change the relevant file set significantly. For now, single-shot
    // gather using only the seed (no userMessages) — round 1 sees
    // these alongside the seed, and round 2+ keeps them visible too.
    let repoExcerpts: FileExcerpt[] = [];
    try {
      repoExcerpts = await gatherProposerContext({
        clonePath: destPath,
        seed,
        repoFiles,
      });
      if (repoExcerpts.length > 0) {
        this.appendSystem(
          `Pre-fetched ${repoExcerpts.length} file excerpt(s) for proposer grounding: ${repoExcerpts.map((e) => e.path).join(", ")}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Context gather failed (${msg}); proposers will work with file names only.`);
    }

    // 2026-05-02 (quality lever #2): derive a per-run rubric BEFORE
    // the discussion loop. First aggregator (or first proposer if no
    // aggregator) runs the derivation. Best-effort.
    const rubricAgent = aggregators[0] ?? proposers[0];
    if (rubricAgent && cfg.userDirective) {
      this.appendSystem(`Deriving success rubric from directive (lever #2)…`);
      this.derivedRubric = await deriveRubric({
        agent: rubricAgent,
        manager: this.opts.manager,
        directive: cfg.userDirective,
      });
      this.appendSystem(
        `Rubric derived: ${this.derivedRubric.criteria.length} criteria, shape "${this.derivedRubric.deliverableShape}".`,
      );
      // 2026-05-02 (matrix row #1): advisory auto-tune. Compute the
      // proposer count this rubric warrants; surface a recommendation
      // when it differs from what's actually configured. We don't
      // re-spawn mid-run — that's bigger structural work — but
      // surfacing the gap closes the "how many proposers should I
      // have used?" question the user otherwise discovers post-hoc.
      const recommendedCount = recommendProposerCount(this.derivedRubric);
      if (recommendedCount !== proposerCount) {
        this.appendSystem(
          `[advisory] Rubric complexity suggests ${recommendedCount} proposer${recommendedCount === 1 ? "" : "s"} (currently ${proposerCount}). Consider re-running with agentCount=${recommendedCount} for next time; this run continues with ${proposerCount}.`,
        );
      }
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();

    let priorSynthesis: string | null = null;
    // 2026-05-02: track raw round-N proposals so round N+1 can engage
    // with specific points the synthesis compressed away.
    let priorProposals: string[] = [];
    const rounds = Math.max(1, Math.min(10, cfg.rounds ?? 1));
    // 2026-05-02 (matrix row #5): per-task-class threshold from the
    // rubric's deliverableShape. Analysis tasks converge fast (0.7);
    // decision/debate tasks resist convergence (0.4) because surfacing
    // tradeoffs is the point. User-supplied moaConvergenceThreshold
    // always wins — this is just the default.
    const convergenceThreshold =
      cfg.moaConvergenceThreshold ??
      thresholdForDeliverableShape(this.derivedRubric?.deliverableShape);
    // 2026-05-03 (post-Phase-D follow-up): budget + quota guard parity
    // with the other 8 runners. Pre-fix MoA was the only preset that
    // could blow past cfg.tokenBudget without halting (audit Pattern 2a).
    const tokenBaseline = snapshotLifetimeTokens();
    for (let round = 1; round <= rounds; round++) {
      if (this.stopping) break;
      const guard = checkBudgetGuards({
        tokenBaseline,
        tokenBudget: cfg.tokenBudget,
        round,
        totalRounds: rounds,
        unit: "round",
      });
      if (guard.halt) {
        this.earlyStopDetail = guard.earlyStopDetail;
        this.appendSystem(guard.message ?? "");
        break;
      }
      this.round = round;
      this.actualRoundsCompleted = round;
      this.appendSystem(`── MoA Round ${round}/${rounds} — Layer 1: ${proposerCount} proposers (peer-hidden) ──`);

      // #119 + 2026-05-02 (chat lever #3): pull user-role transcript
      // entries each round so chat injections reach agents. PER-AGENT
      // filter via userEntryVisibleTo honors @mention routing — a
      // user message tagged targetAgent="agent-2" lands ONLY in
      // agent-2's prompt, not the other proposers'. Broadcast messages
      // (no targetAgent) reach everyone.
      const userEntries = this.transcript.filter((e) => e.role === "user");

      // Layer 1: parallel, peer-hidden proposers. Build the prompt
      // PER-PROPOSER so the @mention filter can run against each
      // agent's id. Pre-fix this was built once and shared across all
      // proposers — fine for broadcast chat but couldn't honor
      // targeted routing.
      const proposals = await Promise.all(
        proposers.map((agent, idx) => {
          const userMessages = userEntries
            .filter((e) => userEntryVisibleTo(e, agent.id))
            .map((e) => e.text);
          // 2026-05-02 (matrix row #2): designate the LAST proposer as
          // challenger when N≥2. Prevents consensus-flattening that's
          // MoA's biggest failure mode. With N=1 there's no consensus
          // to flatten, so the variant is moot.
          const isChallenger = proposers.length >= 2 && idx === proposers.length - 1;
          const proposerPrompt = buildProposerPrompt({
            seed,
            repoFiles,
            readme,
            priorSynthesis,
            userMessages,
            // 2026-05-02 (lever #3 — MoA improvement): pass prior round's
            // raw proposer drafts so this round's proposers can engage
            // with peers' specific points, not just the synthesis.
            priorProposals,
            // 2026-05-02 (lever #1 — MoA improvement): pre-fetched file
            // excerpts for grounding. Same set across rounds.
            repoExcerpts,
            variant: isChallenger ? "challenger" : "default",
          });
          return this.runOne(agent, proposerPrompt, `proposer-${idx + 1}`).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.appendSystem(`[${agent.id}] proposer prompt failed: ${msg}`);
            return null;
          });
        }),
      );
      if (this.stopping) return;

      const validProposals = proposals
        .map((p, idx) => (p ? { workerId: proposers[idx].id, text: p } : null))
        .filter((p): p is { workerId: string; text: string } => p !== null);

      if (validProposals.length === 0) {
        this.appendSystem(`MoA round ${round}: all ${proposerCount} proposers failed; aborting.`);
        this.setPhase("failed");
        return;
      }

      // #93 deeper (2026-05-01): K aggregators in parallel + central pick.
      // Each aggregator gets a slightly different system-prompt variation
      // (clarity / completeness / actionability). When K=1, the rotation
      // collapses to the canonical prompt = current behavior.
      this.appendSystem(
        `── Layer 2: ${aggregators.length} aggregator(s) synthesizing ${validProposals.length}/${proposerCount} proposals (parallel) ──`,
      );

      const synthResults = await Promise.all(
        aggregators.map((agg, idx) => {
          const variant = AGGREGATOR_VARIANTS[idx % AGGREGATOR_VARIANTS.length];
          // Per-aggregator @mention filter — same rule as the proposer
          // loop above. Lets the user @<aggregator-id> nudge synthesis
          // bias without affecting the proposer drafts.
          const aggUserMessages = userEntries
            .filter((e) => userEntryVisibleTo(e, agg.id))
            .map((e) => e.text);
          const synthPrompt = buildAggregatorPrompt({
            seed,
            proposals: validProposals,
            variantBias: variant,
            userMessages: aggUserMessages,
          });
          return this.runOne(agg, synthPrompt, `aggregator-${idx + 1}-${variant}`)
            .then((text) => ({ ok: true as const, idx, text, agg }))
            .catch((err) => ({ ok: false as const, idx, err, agg }));
        }),
      );
      if (this.stopping) return;

      const validSyntheses = synthResults.filter(
        (r): r is { ok: true; idx: number; text: string; agg: Agent } => r.ok,
      );
      if (validSyntheses.length === 0) {
        this.appendSystem(`MoA round ${round}: all ${aggregators.length} aggregator(s) failed; aborting.`);
        this.setPhase("failed");
        return;
      }

      // 2026-05-02 (issue #3 fix): per-aggregator self-critique BEFORE
      // pick. Pre-fix order was central-pick → critique winner.
      // Problem: central-pick optimizes for consensus (the synthesis
      // closest to other K-1) while self-critique tries to surface
      // disagreement — the two mechanisms pulled opposite directions
      // on the same artifact. Now: critique each of K syntheses in
      // parallel (cheap because aggregators already have context),
      // prefer REVISE results (they surfaced real disagreement); fall
      // back to central-pick when all APPROVED.
      let synthesis: string;
      let winningAgg: Agent;
      if (validSyntheses.length === 1) {
        synthesis = validSyntheses[0].text;
        winningAgg = validSyntheses[0].agg;
      } else {
        // Critique each aggregator's synthesis with a different agent
        // (issue #2 fix — anchoring bias). The critic for aggregator-i
        // is aggregator-(i+1)%K so each gets a fresh-eyes review.
        const critiqueResults = await Promise.all(
          validSyntheses.map(async (s, idx) => {
            const critic = validSyntheses[(idx + 1) % validSyntheses.length].agg;
            const critiqued = await this.runAggregatorSelfCritique(
              critic,
              s.text,
              validProposals,
            );
            return { idx, original: s.text, critiqued, agg: s.agg, revised: critiqued !== s.text };
          }),
        );
        const reviseCount = critiqueResults.filter((r) => r.revised).length;
        // Prefer REVISE results — they surface real disagreement that
        // an APPROVED-by-default critique would have flattened.
        const revisedOnly = critiqueResults.filter((r) => r.revised);
        let pickedIdx: number;
        if (revisedOnly.length === 1) {
          pickedIdx = revisedOnly[0].idx;
        } else if (revisedOnly.length >= 2) {
          // Among revised, pick the central one (most "agreement-with-
          // peers" among the post-revision pool — these are the
          // syntheses that surfaced disagreement that OTHER critiques
          // also surfaced, so it's a robust signal not a one-off).
          const central = pickMostCentralAggregator(revisedOnly.map((r) => r.critiqued));
          pickedIdx = revisedOnly[central.winnerIdx].idx;
        } else {
          // All APPROVED — fall back to central-pick on the originals.
          const central = pickMostCentralAggregator(critiqueResults.map((r) => r.critiqued));
          pickedIdx = central.winnerIdx;
        }
        const picked = critiqueResults[pickedIdx];
        synthesis = picked.critiqued;
        winningAgg = picked.agg;
        this.appendSystem(
          `[multi-aggregator + critique] ${validSyntheses.length} synthesized · ${reviseCount}/${validSyntheses.length} REVISED · winner=aggregator-${pickedIdx + 1}${picked.revised ? " (revised)" : " (approved)"}`,
        );
      }

      // T199 (2026-05-04): N-level MoA aggregation tree. Generalizes
      // T198e's two-stage to arbitrary depth. Each level halves the
      // input set (rounded up); top level always emits 1 synthesis.
      // Capped at 4 levels for runtime sanity. cfg.moaAggregationLevels
      // takes precedence over cfg.twoStageMoA (which is the L=2 case).
      const requestedLevels =
        cfg.moaAggregationLevels && cfg.moaAggregationLevels >= 2
          ? Math.min(4, cfg.moaAggregationLevels)
          : cfg.twoStageMoA
            ? 2
            : 1;
      if (requestedLevels >= 2 && validSyntheses.length >= 2) {
        try {
          const treeResult = await this.runAggregationTree({
            seed,
            initialInputs: validSyntheses.map((s, i) => ({
              workerId: `aggregator-${i + 1}`,
              text: s.text,
            })),
            levels: requestedLevels,
            availableAggregators: aggregators,
          });
          if (treeResult.text && treeResult.text.trim().length > 0) {
            this.appendSystem(
              `[T199 multi-tier MoA] ${requestedLevels}-level aggregation tree completed (${validSyntheses.length} L0 → ${treeResult.layerSizes.slice(1).join(" → ")} → 1).`,
            );
            synthesis = treeResult.text;
          } else {
            this.appendSystem(
              `[T199 multi-tier MoA] tree produced empty top synthesis — falling back to single-pick winner.`,
            );
          }
        } catch (err) {
          this.appendSystem(
            `[T199 multi-tier MoA] tree failed (${err instanceof Error ? err.message : String(err)}) — falling back to single-pick winner.`,
          );
        }
      }

      // 2026-05-02 (issue #1 fix): challenger substantiveness telemetry.
      // When N≥2, the LAST proposer was designated challenger (matrix
      // row #2). Score how much of the challenger's UNIQUE contribution
      // survived into the synthesis — a low ratio means the challenger
      // is wheel-spinning + we should consider disabling next time.
      // Pure logging; does not auto-disable.
      if (validProposals.length >= 2 && proposers.length >= 2) {
        const challengerProposer = proposers[proposers.length - 1];
        const challengerEntry = validProposals.find((p) => p.workerId === challengerProposer.id);
        if (challengerEntry) {
          const otherDrafts = validProposals
            .filter((p) => p.workerId !== challengerProposer.id)
            .map((p) => p.text);
          const score = scoreChallengerSubstantiveness({
            challengerDraft: challengerEntry.text,
            otherDrafts,
            synthesis,
          });
          if (score.ratio === null) {
            this.appendSystem(
              `[issue #1] Challenger telemetry: REDUNDANT — challenger draft had no tokens unique vs other proposers. (ratio=null)`,
            );
          } else {
            this.appendSystem(
              `[issue #1] Challenger telemetry: ${score.bucket.toUpperCase()} — ${score.incorporatedTokenCount}/${score.uniqueTokenCount} unique tokens kept in synthesis (ratio=${score.ratio.toFixed(2)})`,
            );
          }
        }
      }

      // 2026-05-02 (matrix row #3 + issue #2 + issue #3 fixes):
      // self-critique. K≥2 case is handled inline above (per-aggregator
      // critique → pick post-revision); K=1 case still needs critique
      // against a different agent (challenger or proposer) to escape
      // anchoring bias.
      if (validSyntheses.length === 1) {
        const criticAgent = pickSelfCritiqueAgent({
          winningAgg,
          aggregators,
          proposers,
          validSyntheses,
        });
        synthesis = await this.runAggregatorSelfCritique(
          criticAgent,
          synthesis,
          validProposals,
        );
      }

      // #93 deeper: convergence detection. After round 2+, check if the
      // new synthesis is similar enough to the prior round's that we can
      // stop early. Saves rounds × (proposer + K aggregator) calls.
      //
      // 2026-05-02 (issue #4 fix): try EMBEDDING-based semantic
      // convergence first; fall back to Jaccard on null (embedding
      // model not pulled or call failed). Embeddings catch "same
      // meaning, different words" that Jaccard's word-overlap misses.
      if (priorSynthesis !== null) {
        let signal: "embedding" | "jaccard" = "jaccard";
        let similarity: number;
        let threshold: number;
        let converged: boolean;
        const ollamaBaseUrl = this.opts.ollamaBaseUrl;
        if (ollamaBaseUrl) {
          const semantic = await detectSemanticConvergence({
            prior: priorSynthesis,
            current: synthesis,
            ollamaBaseUrl,
            threshold: jaccardToCosineThreshold(convergenceThreshold),
          });
          if (semantic !== null) {
            signal = "embedding";
            similarity = semantic.similarity;
            threshold = semantic.threshold;
            converged = semantic.converged;
          } else {
            const verdict = detectConvergence(priorSynthesis, synthesis, convergenceThreshold);
            similarity = verdict.similarity;
            threshold = verdict.threshold;
            converged = verdict.converged;
          }
        } else {
          const verdict = detectConvergence(priorSynthesis, synthesis, convergenceThreshold);
          similarity = verdict.similarity;
          threshold = verdict.threshold;
          converged = verdict.converged;
        }
        this.appendSystem(
          `[convergence] round ${round} vs ${round - 1}: ${signal}=${similarity.toFixed(3)} threshold=${threshold.toFixed(3)} converged=${converged}`,
        );
        // T189 (2026-05-04): aggregator confidence override. T178 added
        // the parser; this wires it to behavior. When aggregator self-
        // reports CONFIDENCE: low AND we still have rounds remaining,
        // OVERRIDE convergence-stop and force another round. The text
        // is similar to last round's, but the aggregator says it's not
        // confident the synthesis is right — so similarity isn't
        // signal of true convergence, just stalled iteration.
        const aggConfidence = parseAggregatorConfidence(synthesis);
        if (aggConfidence === "low" && converged && round < rounds) {
          this.appendSystem(
            `[T189 aggregator-confidence override] Aggregator self-reported CONFIDENCE: low; ignoring convergence signal and forcing another round (round ${round + 1}/${rounds}).`,
          );
          converged = false;
        } else if (aggConfidence === "low") {
          this.appendSystem(
            `[T189 aggregator-confidence] CONFIDENCE: low this round but no more rounds available — synthesis lands as-is. Consider increasing rounds or providing more context.`,
          );
        }
        if (converged) {
          this.appendSystem(
            `MoA converged after round ${round} (${signal} similarity ${similarity.toFixed(3)} ≥ ${threshold.toFixed(3)}); stopping early.`,
          );
          priorSynthesis = synthesis;
          break;
        }
      }

      priorSynthesis = synthesis;
      // 2026-05-02 (lever #3): capture this round's raw proposals for
      // the next round's prompt. Use validProposals (not the bare prompt
      // results) so failed proposers don't pollute the peer-reveal block.
      priorProposals = validProposals.map((p) => p.text);
      // 2026-05-02 (issue #5 fix): re-gather context BETWEEN rounds.
      // Synthesis may have surfaced files/symbols round 1 didn't pick.
      // Additive — keeps existing excerpts, adds new ones up to the cap.
      // Best-effort.
      if (round < rounds && !this.stopping) {
        try {
          const additional = await gatherProposerContext({
            clonePath: destPath,
            seed,
            repoFiles,
            priorSynthesis,
            alreadyFetched: repoExcerpts.map((e) => e.path),
          });
          if (additional.length > 0) {
            const before = repoExcerpts.length;
            repoExcerpts = [...repoExcerpts, ...additional];
            this.appendSystem(
              `[issue #5] Round ${round + 1} additive gather: +${additional.length} new file excerpt${additional.length === 1 ? "" : "s"} (${additional.map((e) => e.path).join(", ")}); total ${repoExcerpts.length} (was ${before}).`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Mid-run gather failed (${msg}); proposers will continue with prior excerpts.`);
        }
      }
    }

    this.appendSystem(`MoA finished after ${this.actualRoundsCompleted} round(s) (capped at ${rounds}).`);
    // setPhase("completed") + killAll happen in loop()'s finally block.
  }

  // 2026-05-01: mirror of CouncilRunner.writeSummary. MoA was missing
  // this entirely; eval harness consumes <clonePath>/summary.json so the
  // missing write meant every MoA attempt re-read the previous run's
  // summary. Pure end-of-run snapshot; no agent stats yet (MoA doesn't
  // wire AgentStatsCollector — future enhancement).
  // 2026-05-02 (deliverables initiative + quality levers #1-#3):
  // structured markdown artifact for MoA. Pulls the final aggregator
  // output + per-proposer drafts from the transcript (last agent entry
  // per role). Augmented by runQualityPasses with rubric/critic/next-
  // actions. Best-effort.
  private async writeMoaDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // The transcript carries N proposer agent entries + 1 aggregator
    // entry per round (no distinctive summary kind on MoA today; the
    // last agent entry per round is the aggregator's synthesis).
    const agentEntries = this.transcript.filter((e) => e.role === "agent");
    if (agentEntries.length === 0) return;
    const finalSynthesis = agentEntries[agentEntries.length - 1]?.text ?? "";
    // Layer 1 round-1 proposers — the first N agent entries.
    const proposerCount = cfg.agentCount;
    const round1Proposers = agentEntries.slice(0, proposerCount);
    const baseSections = [
      {
        title: "Final synthesis",
        body: finalSynthesis.length > 0 ? finalSynthesis : "_(empty synthesis)_",
      },
      {
        title: `Round 1 — ${round1Proposers.length} independent proposer drafts`,
        body:
          round1Proposers.length > 0
            ? round1Proposers
                .map((e) => `### Proposer ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
                .join("\n\n")
            : "_(no proposer drafts captured)_",
      },
    ];
    // 2026-05-02 (quality levers #1-#3): augment with rubric +
    // critic + next-actions. Use the last agent in the manager list
    // (typically an aggregator) as critic to avoid burning a separate
    // agent slot.
    const allAgents = this.opts.manager.list();
    const criticAgent = allAgents[allAgents.length - 1] ?? null;
    const sections = await runQualityPasses({
      baseSections,
      rubric: this.derivedRubric,
      criticAgent,
      manager: this.opts.manager,
    });
    const result = writeDeliverable({
      preset: "moa",
      runId: cfg.runId,
      clonePath: cfg.localPath,
      title: "MoA synthesis",
      subtitle: `${proposerCount} proposer${proposerCount === 1 ? "" : "s"} + aggregator across ${this.actualRoundsCompleted} round${this.actualRoundsCompleted === 1 ? "" : "s"}`,
      sections,
    });
    if (result.ok) {
      this.appendSystemWithSummary(`Deliverable saved → ${result.filename}`, {
        kind: "deliverable",
        preset: "moa",
        filename: result.filename,
        fullPath: result.fullPath,
        bytes: result.bytes,
        sectionTitles: sections.map((s) => s.title),
      });
    } else {
      this.appendSystem(`Failed to write deliverable (${result.reason})`);
    }

    // T2.2 (2026-05-04): opt-in wrap-up apply phase. The aggregator
    // (the agent who synthesized) doubles as implementer; falls back
    // to any available agent if the aggregator slot is empty.
    const implementer = criticAgent ?? allAgents[0] ?? null;
    if (implementer) {
      await maybeRunWrapUpApply({
        cfg,
        presetName: "moa",
        agent: implementer,
        manager: this.opts.manager,
        repos: this.opts.repos,
        emit: this.opts.emit,
        appendSystem: (text) => this.appendSystem(text),
      });
    }
  }

  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
    // 2026-05-03 (Phase C): writeSummary body extracted to shared helper.
    // MoA opts out of: banner emission (no per-agent stats to render),
    // files=N suffix in log line, and overrides rounds with
    // `actualRoundsCompleted`.
    // 2026-05-03 (post-Phase-D): earlyStopDetail now wired up for the
    // budget/quota guard added to the MoA loop.
    await discussionWriteSummary({
      cfg,
      crashMessage,
      stopping: this.stopping,
      startedAt: this.startedAt,
      earlyStopDetail: this.earlyStopDetail,
      rounds: this.actualRoundsCompleted || cfg.rounds,
      agentCount: cfg.agentCount,
      // MoA doesn't track AgentStatsCollector yet — empty array is the
      // honest "no per-agent metrics" placeholder. The runId + transcript
      // give the eval harness everything it needs to score uniqueness.
      agents: [],
      transcript: this.transcript,
      topology: cfg.topology,
      repos: this.opts.repos,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
      emitBanner: false,
      includeFilesInLogLine: false,
    });
  }

  /** One prompt → cleaned text. Records the agent message in the
   *  transcript. Throws on transport errors so the caller can decide
   *  whether to abort the whole round.
   *
   *  2026-05-01 bug fix: emit agent_state events around the prompt so
   *  the UI sidebar shows current status. Pre-fix: MoaRunner had zero
   *  emitAgentState calls (BlackboardRunner has 5+); the sidebar
   *  showed agents at their initial spawn state ("ready") forever
   *  while they were actually thinking. */
  // 2026-05-02 (matrix row #3 + issue #2 fix): aggregator self-critique
  // T199 (2026-05-04): N-level MoA aggregation tree. Recursively
  // halves the input set across L levels, each level synthesizing
  // ceil(n/2) outputs from n inputs (final level emits 1). Aggregator
  // agents are reused round-robin; if not enough aggregators exist
  // for a level, the runner cycles through the available pool.
  // Bounded at 4 levels by the caller (cfg.moaAggregationLevels cap).
  // Per-level failure logs + falls through to the previous level's
  // input as the layer's output (graceful degradation).
  private async runAggregationTree(input: {
    seed: string;
    initialInputs: ReadonlyArray<{ workerId: string; text: string }>;
    levels: number;
    availableAggregators: readonly Agent[];
  }): Promise<{ text: string; layerSizes: number[] }> {
    const { seed, initialInputs, levels, availableAggregators } = input;
    if (availableAggregators.length === 0) {
      throw new Error("runAggregationTree: no aggregators available");
    }
    let currentLayer: Array<{ workerId: string; text: string }> = [
      ...initialInputs,
    ];
    const layerSizes: number[] = [currentLayer.length];
    for (let level = 1; level <= levels; level++) {
      const isTopLevel = level === levels;
      // Top level always emits 1; intermediate levels halve.
      const nextSize = isTopLevel ? 1 : Math.max(1, Math.ceil(currentLayer.length / 2));
      // Partition current layer into nextSize chunks, ensuring each chunk has at least 1 item.
      const chunks = chunkRoundRobin(currentLayer, nextSize);
      const tasks = chunks.map(async (chunk, idx) => {
        if (chunk.length === 0) return null;
        // Pass-through optimization: chunk of 1 doesn't need an
        // aggregator pass (no synthesis to do). Save the call.
        if (chunk.length === 1) return chunk[0]!;
        const agg = availableAggregators[idx % availableAggregators.length]!;
        const prompt = buildAggregatorPrompt({
          seed,
          proposals: chunk,
          variantBias: "balanced",
        });
        try {
          const ctrl = new AbortController();
          // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
          const result = (await promptWithFailoverAuto(agg, prompt, {
            signal: ctrl.signal,
            manager: this.opts.manager,
            agentName: "swarm-read",
            describeError: (e) => describeSdkError(e),
          })) as { data?: { parts?: Array<{ type: string; text: string }> } };
          const text = extractText(
            result.data?.parts?.find((p) => p.type === "text")?.text ?? "",
          );
          if (!text || text.trim().length === 0) return null;
          return { workerId: `L${level}-agg-${idx + 1}`, text };
        } catch {
          return null;
        }
      });
      const settled = await Promise.all(tasks);
      const valid = settled.filter(
        (s): s is { workerId: string; text: string } => s !== null,
      );
      if (valid.length === 0) {
        // All aggregators on this level failed — surface the previous
        // level's first input as the fallback so we still return SOMETHING.
        return {
          text: currentLayer[0]?.text ?? "",
          layerSizes,
        };
      }
      currentLayer = valid;
      layerSizes.push(currentLayer.length);
      if (isTopLevel) break;
    }
    // Top level should be exactly 1; defensive pick if it's somehow >1.
    return { text: currentLayer[0]!.text, layerSizes };
  }

  // with a DIFFERENT-AGENT review. Pre-fix the winning aggregator
  // reviewed its OWN synthesis — anchoring bias kills detection. Now
  // the critic is picked by pickSelfCritiqueAgent (a loser aggregator
  // when K≥2, the challenger proposer when K=1) so the review actually
  // sees the synthesis with fresh eyes. One pass only — no recursion.
  // Best-effort: any failure keeps the original synthesis.
  private async runAggregatorSelfCritique(
    agg: Agent,
    synthesis: string,
    proposals: ReadonlyArray<{ workerId: string; text: string }>,
  ): Promise<string> {
    if (proposals.length < 2) return synthesis; // no diversity to critique against
    if (this.stopping) return synthesis;
    const prompt = [
      "You are reviewing YOUR OWN synthesis for the MoA team. Read the proposers' answers below and your synthesis, then decide:",
      "  - APPROVED: synthesis fairly captures consensus AND surfaces meaningful disagreement.",
      "  - REVISE: synthesis dropped substantive disagreement, over-weighted one proposer, or smoothed away a real tradeoff.",
      "",
      "Output STRICT JSON only, no prose, no markdown fences:",
      '  {"verdict": "APPROVED" | "REVISE", "rationale": "<one sentence>", "revised": "<full revised synthesis if REVISE, else empty string>"}',
      "",
      "Be honest. APPROVED is fine when the synthesis is good. Only REVISE when there's a SPECIFIC named gap (e.g. 'Proposer 3 raised X which I dropped').",
      "",
      `PROPOSERS (${proposals.length}):`,
      ...proposals.map(
        (p, i) => `\n--- Proposer ${i + 1} (${p.workerId}) ---\n${p.text.slice(0, 2000)}`,
      ),
      "",
      "YOUR CURRENT SYNTHESIS:",
      "--- BEGIN ---",
      synthesis.slice(0, 4000),
      "--- END ---",
      "",
      "Output JSON now:",
    ].join("\n");
    let raw: string;
    try {
      raw = await this.runOne(agg, prompt, "aggregator-self-critique");
    } catch {
      return synthesis;
    }
    if (!raw) return synthesis;
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) return synthesis;
    let parsed: { verdict?: unknown; rationale?: unknown; revised?: unknown };
    try {
      parsed = JSON.parse(objMatch[0]);
    } catch {
      return synthesis;
    }
    const verdict = parsed.verdict === "REVISE" ? "REVISE" : "APPROVED";
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    if (verdict === "APPROVED") {
      this.appendSystem(`[matrix #3] Aggregator self-critique: APPROVED. ${rationale}`);
      return synthesis;
    }
    const revised = typeof parsed.revised === "string" ? parsed.revised.trim() : "";
    if (revised.length < 50) {
      // Revision too short to be real — model said REVISE but didn't deliver.
      this.appendSystem(
        `[matrix #3] Aggregator self-critique flagged REVISE but produced no usable revision; keeping original synthesis. (${rationale})`,
      );
      return synthesis;
    }
    this.appendSystem(`[matrix #3] Aggregator self-critique: REVISED. ${rationale}`);
    return revised;
  }

  private async runOne(agent: Agent, prompt: string, label: string): Promise<string> {
    const ctrl = new AbortController();
    const startedAt = Date.now();
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState(agent, "thinking", startedAt);
    try {
      // T-Item-MoaTools (2026-05-04): when cfg.moaProposerTools is set,
      // promote the proposer's agentName to "swarm-read" so the
      // provider's chat path binds read-only tools (read/grep/glob/list).
      // Default "swarm" gives no tools — proposer relies on pre-fetched
      // context only.
      const proposerAgentName = this.active?.moaProposerTools
        ? "swarm-read"
        : "swarm";
      // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
      const res = (await promptWithFailoverAuto(agent, prompt, {
        signal: ctrl.signal,
        manager: this.opts.manager,
        formatExpect: "free",
        describeError: (e) => describeSdkError(e),
        agentName: proposerAgentName,
      })) as { data: { parts: Array<{ type: "text"; text: string }> } };
      const raw = extractText(res) ?? "";
      const stripped = stripAgentText(raw);
      const cleaned = stripped.finalText;
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: cleaned,
        ts: Date.now(),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      void label;
      return cleaned;
    } finally {
      // Always reset status — the agent isn't thinking anymore even if
      // the prompt threw.
      this.opts.manager.markStatus(agent.id, "ready");
      this.emitAgentState(agent, "ready");
    }
  }

  /** Mirror of BlackboardRunner.emitAgentState — surfaces per-agent
   *  status flips to the WS so the sidebar's AgentPanel updates live.
   *  Without this the panel shows the spawn-time state forever. */
  private emitAgentState(agent: Agent, status: "thinking" | "ready", thinkingSince?: number): void {
    this.opts.emit({
      type: "agent_state",
      agent: {
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status,
        ...(thinkingSince !== undefined ? { thinkingSince } : {}),
      },
    });
  }

  private setPhase(p: SwarmPhase): void {
    this.phase = p;
    this.opts.emit({ type: "swarm_state", phase: p, round: this.round });
  }

  private appendSystem(text: string, summary?: TranscriptEntry["summary"]): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "system",
      text,
      ts: Date.now(),
      ...(summary ? { summary } : {}),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  // 2026-05-02 (deliverables initiative): convenience wrapper so the
  // deliverable writer doesn't have to re-build the full system entry
  // shape just to attach a summary.
  private appendSystemWithSummary(text: string, summary: TranscriptEntry["summary"]): void {
    this.appendSystem(text, summary);
  }
}

// 2026-05-02 (issue #2 fix): pick a self-critique agent that's NOT the
// winning aggregator. Anchoring bias is well-documented — models are
// bad at finding errors in their own output. Picking a different agent
// (different conversation context at minimum, different model when
// heterogeneous) gives the critique fresh eyes.
//
// Selection priority:
//   1. Loser aggregator (K≥2 case): one of the K-1 aggregators that
//      DIDN'T win the central-pick. Different model when heterogeneous;
//      at minimum a different prompt context.
//   2. Challenger proposer (K=1 case): the last proposer was already
//      designated as challenger (matrix row #2) — its red-team
//      framing is exactly the disposition self-critique needs.
//   3. First non-winning proposer: fallback when challenger isn't
//      designated (proposerCount === 1 — no challenger).
//   4. Winning aggregator: last-resort fallback (preserves prior
//      behavior, never null).
//
// Pure — exported for tests.
export function pickSelfCritiqueAgent(input: {
  winningAgg: Agent;
  aggregators: readonly Agent[];
  proposers: readonly Agent[];
  validSyntheses: ReadonlyArray<{ ok: true; idx: number; text: string; agg: Agent }>;
}): Agent {
  // Priority 1: loser aggregator
  if (input.aggregators.length >= 2) {
    const winnerId = input.winningAgg.id;
    const loser = input.aggregators.find((a) => a.id !== winnerId);
    if (loser) return loser;
  }
  // Priority 2: challenger proposer (last proposer when N≥2 — see
  // matrix row #2 designation logic)
  if (input.proposers.length >= 2) {
    return input.proposers[input.proposers.length - 1];
  }
  // Priority 3: first non-winning proposer
  if (input.proposers.length >= 1) {
    return input.proposers[0];
  }
  // Priority 4: fallback to winning aggregator (preserves pre-fix behavior)
  return input.winningAgg;
}

// ---------------------------------------------------------------------------
// Pure prompt builders — exported for tests.
// ---------------------------------------------------------------------------

export type ProposerVariant =
  | "default"
  | "challenger"
  // T178 (2026-05-04): added 3 more biases — creative (lateral
  // thinking), empirical (evidence-grounded only), conservative
  // (proven patterns + risk-aware). Pre-T178 only default/challenger.
  | "creative"
  | "empirical"
  | "conservative";

/** T178 (2026-05-04): rotation order when N proposers run with mixed
 *  variants. The runner cycles through this list (skipping default)
 *  to assign biases. Pre-T178 the runner only flipped one to
 *  "challenger" via the `isChallenger` boolean — that mechanism is
 *  preserved as the default; future MoA work can switch to full
 *  rotation across all 4 non-default variants. */
export const PROPOSER_VARIANTS: readonly ProposerVariant[] = [
  "default",
  "challenger",
  "creative",
  "empirical",
  "conservative",
];

export interface ProposerPromptInput {
  seed: string;
  repoFiles: readonly string[];
  readme: string | null;
  /** 2026-05-02 (matrix row #2): per-proposer variant. "default" is
   *  the cooperative consensus-friendly framing; "challenger" is a
   *  red-team prompt that explicitly seeks counter-arguments + holes
   *  in the likely consensus. When N≥2 proposers, designating ONE
   *  as challenger prevents the consensus-flattening default that
   *  makes MoA outputs blander than they should be. */
  variant?: ProposerVariant;
  /** Set on round 2+ — the prior round's aggregator synthesis. Lets
   *  proposers ground their fresh draft on what the team converged on
   *  last time without polluting layer-1 independence within a round. */
  priorSynthesis: string | null;
  /** #119 (2026-05-01): mid-run user chat injections from /api/swarm/say.
   *  Pre-fix: MoA never consumed user-role transcript entries; chat was
   *  display-only. Now folded into proposer prompts as a HIGHEST-priority
   *  input — same convention as the 7 other discussion runners' [HUMAN]
   *  formatter. Empty array on fresh runs / no chat activity. */
  userMessages?: readonly string[];
  /** 2026-05-02: full peer-proposer drafts from the prior round. Set on
   *  round 2+ ALONGSIDE priorSynthesis — the aggregator's compression
   *  loses nuance, so seeing the raw drafts lets proposers respond to
   *  specific points others raised. Within a round, layer-1 is still
   *  peer-hidden (proposers don't see each other's CURRENT drafts);
   *  this is strictly cross-round. Empty/absent on round 1. */
  priorProposals?: readonly string[];
  /** 2026-05-02 (lever #1): retrieval-augmented file excerpts gathered
   *  before the round via moaContextGather. Each excerpt is up to 1500
   *  chars (head); the gather picks 8 high-relevance files based on
   *  seed terms + standard config presence. Pre-fix proposers only saw
   *  the file NAMES; this gives them enough actual content to ground
   *  their drafts. Empty when gather fails or returns no readable
   *  files. */
  repoExcerpts?: readonly { path: string; excerpt: string }[];
}

export function buildProposerPrompt(input: ProposerPromptInput): string {
  const parts: string[] = [];
  const variant = input.variant ?? "default";
  // T178 (2026-05-04): proposer specialization via system-prompt biases.
  // Pre-T178: only "default" + "challenger" variants. Now adds
  // "creative" (generative, expansive — willing to suggest non-obvious
  // angles), "empirical" (evidence-grounded — every claim cites a
  // file or test), and "conservative" (risk-averse — prefers proven
  // patterns, calls out untested speculation). All run with the SAME
  // model — the bias is purely in the system prompt. K diverse drafts
  // > K identical drafts when the aggregator synthesizes.
  if (variant === "challenger") {
    // 2026-05-02 (matrix row #2): adversarial framing.
    parts.push(
      "You are the CHALLENGER on a Mixture-of-Agents team. Your peers are producing standard analyses; your job is to find what they will MISS. Look for: (a) counter-evidence to the likely consensus, (b) tradeoffs being glossed, (c) failure modes or risks not yet named, (d) cases where the directive's framing itself is wrong.",
    );
    parts.push("If after honest review you find no substantive challenge, say so explicitly — don't manufacture disagreement. Otherwise, push back.");
    parts.push("Your response will be aggregated with the other proposers; the aggregator considers your dissent on technical merit, not in bulk.");
  } else if (variant === "creative") {
    parts.push(
      "You are the CREATIVE on a Mixture-of-Agents team. Your peers will produce safe, conventional analyses; your job is to surface non-obvious angles, unconventional framings, or possibilities your peers will overlook. Lateral thinking welcomed; don't just restate what's in the README.",
    );
    parts.push("Be willing to propose ideas that feel weird or speculative — flag them as such, but don't suppress them. The aggregator can reject; you shouldn't pre-reject.");
  } else if (variant === "empirical") {
    parts.push(
      "You are the EMPIRICIST on a Mixture-of-Agents team. Every claim you make MUST cite a specific file, test, log line, or measurement from the repo. No claim without an evidence anchor. If you can't find evidence for a position, you don't take it.",
    );
    parts.push("Use file-read / grep tools liberally. The aggregator will weight your contribution by how well-grounded it is — vague assertions with no anchor will be deprioritized.");
  } else if (variant === "conservative") {
    parts.push(
      "You are the CONSERVATIVE on a Mixture-of-Agents team. Your peers may suggest bold or experimental approaches; your job is to favor proven patterns and explicitly call out where speculation is being treated as established knowledge.",
    );
    parts.push("Prefer reversible decisions over irreversible ones. Flag any claim that depends on unverified assumptions about future behavior. The aggregator considers your perspective alongside more aggressive ones.");
  } else {
    parts.push(
      "You are one of N independent agents on a Mixture-of-Agents team. Respond to the seed below with your own analysis. You CANNOT see what other agents on this round wrote — that's intentional. Do your own thinking.",
    );
    parts.push("Your response will be aggregated with N-1 peers' responses; the aggregator looks for agreement and synthesizes.");
  }
  parts.push("");
  parts.push(input.seed);
  parts.push("");
  parts.push("Repo files (top 50):");
  for (const f of input.repoFiles) parts.push(`  ${f}`);
  if (input.readme) {
    parts.push("");
    parts.push("README (truncated to 2000 chars):");
    parts.push(input.readme.slice(0, 2000));
  }
  if (input.repoExcerpts && input.repoExcerpts.length > 0) {
    // 2026-05-02 (lever #1): retrieval-augmented file content. Pre-fix
    // proposers only saw filenames + README; tasks like "audit README
    // claims" or "evaluate Express vs Fastify" had no actual file
    // content to ground in. These excerpts are pre-fetched by
    // moaContextGather based on seed terms + always-include config files.
    parts.push("");
    parts.push("Pre-fetched file excerpts (head only; use these to ground specific claims):");
    for (const f of input.repoExcerpts) {
      parts.push(`--- ${f.path} ---`);
      parts.push(f.excerpt);
    }
  }
  if (input.priorSynthesis) {
    parts.push("");
    parts.push("Prior round's aggregated synthesis (you may build on or disagree with this):");
    parts.push(input.priorSynthesis.slice(0, 4000));
  }
  if (input.priorProposals && input.priorProposals.length > 0) {
    // 2026-05-02: render raw peer drafts from the prior round so this
    // round's proposers can engage with specific points the synthesis
    // dropped. Cap each draft at 1500 chars so the prompt doesn't blow
    // up with N proposers; the synthesis above already carries the
    // gist.
    parts.push("");
    parts.push("Prior round's individual proposer drafts (verbatim — engage with specific points):");
    for (const [i, p] of input.priorProposals.entries()) {
      parts.push(`--- Peer ${i + 1} (round-1 draft) ---`);
      parts.push(p.slice(0, 1500));
    }
  }
  if (input.userMessages && input.userMessages.length > 0) {
    parts.push("");
    parts.push("Recent user (human) messages — treat as steering input, weight above the seed when in conflict:");
    for (const m of input.userMessages) parts.push(`  [HUMAN] ${m}`);
  }
  parts.push("");
  parts.push("Respond in under 400 words. Plain prose, no JSON envelope, no markdown headers.");
  return parts.join("\n");
}

export type AggregatorVariant = "balanced" | "clarity" | "completeness" | "actionability";

/** Variant rotation list — used by MoaRunner when multiple aggregators
 *  run in parallel. Position [0] is the canonical "balanced" prompt
 *  (preserves single-aggregator behavior when K=1). */
export const AGGREGATOR_VARIANTS: AggregatorVariant[] = [
  "balanced",
  "clarity",
  "actionability",
];

export interface AggregatorPromptInput {
  seed: string;
  proposals: ReadonlyArray<{ workerId: string; text: string }>;
  /** Optional per-aggregator bias — shapes the system instructions
   *  toward one of: balanced (default), clarity, completeness,
   *  actionability. K-aggregator multi-vote rotates through these so
   *  each parallel synthesis emphasizes a different dimension. */
  variantBias?: AggregatorVariant;
  /** #119 (2026-05-01): mid-run user chat injections — same source as
   *  the proposer prompt's userMessages. The aggregator weighs human
   *  steering when reconciling disagreement between proposers. */
  userMessages?: readonly string[];
}

export function buildAggregatorPrompt(input: AggregatorPromptInput): string {
  const variant = input.variantBias ?? "balanced";
  const parts: string[] = [];
  parts.push(
    "You are the aggregator on a Mixture-of-Agents team. You see N independent proposers' answers to the same seed. Synthesize a single coherent answer that:",
  );
  parts.push("  - Surfaces the points multiple proposers agreed on (those are the most reliable signal).");
  parts.push("  - Notes where proposers disagreed, and pick the strongest argument for each side.");
  parts.push("  - Drops ideas only one proposer mentioned UNLESS they're clearly correct on technical merit.");
  parts.push("  - Produces ONE answer, not N answers stitched together.");
  // Variant-specific bias — shapes which axis the synthesis optimizes
  // for. Empirically lets K parallel aggregators produce diverse
  // syntheses that the central-pick step can rank against each other.
  switch (variant) {
    case "clarity":
      parts.push("  - **Bias toward CLARITY**: prefer concrete language, short sentences, no jargon. If you have to choose between technically-correct and easy-to-understand, pick easy-to-understand.");
      break;
    case "completeness":
      parts.push("  - **Bias toward COMPLETENESS**: include every point any proposer raised that has merit, even at the cost of length. Cap at 800 words.");
      break;
    case "actionability":
      parts.push("  - **Bias toward ACTIONABILITY**: structure the answer as concrete next steps. Each paragraph should end with a thing the reader can DO. If a proposer was abstract, translate to concrete.");
      break;
    case "balanced":
    default:
      // No additional bias.
      break;
  }
  parts.push("");
  parts.push("Original seed:");
  parts.push(input.seed);
  if (input.userMessages && input.userMessages.length > 0) {
    parts.push("");
    parts.push("Recent user (human) messages — weight as steering input when proposers disagree:");
    for (const m of input.userMessages) parts.push(`  [HUMAN] ${m}`);
  }
  parts.push("");
  parts.push(`Proposers (${input.proposals.length}):`);
  for (const [i, p] of input.proposals.entries()) {
    parts.push("");
    parts.push(`--- Proposer ${i + 1} (${p.workerId}) ---`);
    parts.push(p.text.slice(0, 4000));
  }
  parts.push("");
  parts.push("Your synthesized answer (under 600 words, plain prose):");
  parts.push("");
  // T178 (2026-05-04): aggregator self-confidence tag. On the FINAL
  // line of your response, output a one-line confidence rating. Lets
  // the runner detect "low-confidence syntheses" — a future round
  // (or another aggregator with a different bias) might be needed
  // when the proposers' inputs were too thin or contradictory to
  // produce a high-confidence synthesis.
  parts.push("On the FINAL line of your response (no markdown, nothing after it), output exactly one of:");
  parts.push("  CONFIDENCE: high   — proposers converged on substantive points; you're confident this synthesis represents the best of their thinking.");
  parts.push("  CONFIDENCE: medium — partial convergence with some tradeoffs; another round (or a differently-biased aggregator) might surface stronger answers.");
  parts.push("  CONFIDENCE: low    — proposers were thin / contradictory / off-topic; this synthesis is the best you can do with what they produced, but it's weakly grounded.");
  return parts.join("\n");
}

// T178 (2026-05-04): parse the aggregator's CONFIDENCE: tag (last line
// of its response). Returns null when no tag is present (treats as
// neutral — no behavioral signal). Trims trailing whitespace and is
// case-insensitive on the value.
export function parseAggregatorConfidence(text: string): "high" | "medium" | "low" | null {
  const lines = text.trim().split(/\r?\n/);
  // Walk backward — accept any of the last 3 non-empty lines so the
  // model is allowed a one-line trailing comment after the tag.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const m = line.match(/^CONFIDENCE:\s*(high|medium|low)\b/i);
    if (m) return m[1]!.toLowerCase() as "high" | "medium" | "low";
  }
  return null;
}

// T199 (2026-05-04): partition `items` into `chunkCount` chunks via
// round-robin assignment (item i → chunk (i % chunkCount)). Each
// chunk has either ⌈n/k⌉ or ⌊n/k⌋ items. Pure — exported for tests.
// Used by runAggregationTree to split a layer's inputs across the
// next layer's aggregators.
export function chunkRoundRobin<T>(
  items: readonly T[],
  chunkCount: number,
): T[][] {
  if (chunkCount <= 0) return [];
  const out: T[][] = Array.from({ length: chunkCount }, () => []);
  for (let i = 0; i < items.length; i++) {
    out[i % chunkCount]!.push(items[i]!);
  }
  return out;
}
