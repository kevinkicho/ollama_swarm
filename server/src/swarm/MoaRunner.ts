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
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import {
  buildProposerPrompt,
  buildAggregatorPrompt,
  pickSelfCritiqueAgent,
  AGGREGATOR_VARIANTS,
  parseAggregatorConfidence,
} from "./moaPromptHelpers.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { extractText } from "./extractText.js";
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
import { userEntryVisibleTo } from "./chatReceipt.js";
import { deriveRubric, recommendProposerCount, type DerivedRubric } from "./rubricPrePass.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import { writeMoaDeliverable as writeMoaDeliverableImpl } from "./moaDeliverableWriter.js";
import {
  runAggregationTree as runAggregationTreeImpl,
  runAggregatorSelfCritique as runAggregatorSelfCritiqueImpl,
} from "./moaAggregation.js";

export class MoaRunner extends DiscussionRunnerBase {
  // 2026-05-01: gates writeSummary so it fires exactly once per run even
  // if the loop exits via multiple paths (early return + finally).
  // Captured by writeSummary; undefined when run ended by exception.
  private actualRoundsCompleted = 0;
  // 2026-05-02 (quality lever #2): rubric derived at run-start; used
  // by writeMoaDeliverable for the Success-criteria section + critic
  // pass.
  private derivedRubric: DerivedRubric | null = null;
  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.actualRoundsCompleted = 0;

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

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      this.multiWriter = new MultiWriterState({
        writeMode: cfg.writeMode,
        conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["moa"],
        clonePath: destPath,
      });
      this.appendSystem(
        `Multi-writer mode enabled — agents will propose hunks during rounds, reconciled via ${cfg.conflictPolicy ?? "pick"} policy.`,
      );
    }

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

      const strategy = cfg.conflictPolicy ?? "pick";
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
        const aggregator = aggregators[0] ?? proposers[0];
        const applyResult = await runWrapUpApplyPhase({
          directive: cfg.userDirective ?? "MoA multi-writer synthesis",
          clonePath: cfg.localPath,
          model: cfg.writeModel ?? cfg.model,
          agent: aggregator!,
          repos: this.opts.repos,
          manager: this.opts.manager,
          emit: this.opts.emit,
          appendSystem: (text) => this.appendSystem(text),
          presetName: "moa",
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

    // setPhase("completed") + killAll happen in loop()'s finally block.
  }

  // 2026-05-01: mirror of CouncilRunner.writeSummary. MoA was missing
  // this entirely; eval harness consumes <clonePath>/summary.json so the
  // missing write meant every MoA attempt re-read the previous run's
  // summary. Pure end-of-run snapshot; no agent stats yet (MoA doesn't
  // wire AgentStatsCollector — future enhancement).
  // 2026-05-02 (deliverables initiative + quality levers #1-#3):
  // structured markdown artifact for MoA. Pulled into moaDeliverableWriter;
  // this thin delegator preserves call-site clarity.
  private async writeMoaDeliverable(cfg: RunConfig): Promise<void> {
    await writeMoaDeliverableImpl({
      cfg,
      transcript: this.transcript,
      derivedRubric: this.derivedRubric,
      actualRoundsCompleted: this.actualRoundsCompleted,
      manager: this.opts.manager,
      repos: this.opts.repos,
      emit: this.opts.emit,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
    });
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
  // T199 (2026-05-04): N-level MoA aggregation tree. Extracted to
  // moaAggregation.ts; this thin delegator preserves call-site clarity.
  private async runAggregationTree(input: {
    seed: string;
    initialInputs: ReadonlyArray<{ workerId: string; text: string }>;
    levels: number;
    availableAggregators: readonly Agent[];
  }): Promise<{ text: string; layerSizes: number[] }> {
    return runAggregationTreeImpl({
      ...input,
      manager: this.opts.manager,
      appendSystem: (text) => this.appendSystem(text),
    });
  }

  // 2026-05-02 (matrix row #3 + issue #2 fix): aggregator self-critique
  // with a DIFFERENT-AGENT review. Extracted to moaAggregation.ts; this
  // thin delegator preserves call-site clarity.
  private async runAggregatorSelfCritique(
    agg: Agent,
    synthesis: string,
    proposals: ReadonlyArray<{ workerId: string; text: string }>,
  ): Promise<string> {
    return runAggregatorSelfCritiqueImpl({
      agg,
      synthesis,
      proposals,
      runOne: (agent, prompt, label) => this.runOne(agent, prompt, label),
      appendSystem: (text) => this.appendSystem(text),
      stopping: this.stopping,
    });
  }

  private async runOne(agent: Agent, prompt: string, label: string): Promise<string> {
    const ctrl = new AbortController();
    const startedAt = Date.now();
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentStatus(agent, "thinking", startedAt);
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
      // Phase 2 (writeMode: multi): collect hunk proposals if multi-writer active
      if (this.multiWriter?.isActive()) {
        const proposalResult = this.multiWriter.addProposal(agent, cleaned);
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
      this.emitAgentStatus(agent, "ready");
    }
  }

  /** Mirror of BlackboardRunner.emitAgentState — surfaces per-agent
   *  status flips to the WS so the sidebar's AgentPanel updates live.
   *  Without this the panel shows the spawn-time state forever. */
  private emitAgentStatus(agent: Agent, status: "thinking" | "ready", thinkingSince?: number): void {
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status,
      ...(thinkingSince !== undefined ? { thinkingSince } : {}),
    });
  }
}
