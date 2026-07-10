// MoA loop body (spawn → rounds → multi-writer reconcile) — extracted from MoaRunner.loopBody.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, SwarmPhase, TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import {
  buildProposerPrompt,
  buildAggregatorPrompt,
  pickSelfCritiqueAgent,
  AGGREGATOR_VARIANTS,
  parseAggregatorConfidence,
} from "./moaPromptHelpers.js";
import {
  detectConvergence,
  pickMostCentralAggregator,
  thresholdForDeliverableShape,
  scoreChallengerSubstantiveness,
} from "./moaConsensus.js";
import { detectSemanticConvergence, jaccardToCosineThreshold } from "./semanticConvergence.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { notifyGuardTrip } from "./guardNotify.js";
import { gatherProposerContext, type FileExcerpt } from "./moaContextGather.js";
import { userEntryVisibleTo } from "./chatReceipt.js";
import { deriveRubric, recommendProposerCount, type DerivedRubric } from "./rubricPrePass.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import { moaCloneAndSpawn } from "./moaSpawn.js";

export interface MoaLoopBodyHost {
  repos: RepoService;
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  ollamaBaseUrl: string | undefined;
  transcript: TranscriptEntry[];
  getStopping: () => boolean;
  getDrainRequested?: () => boolean;
  getDerivedRubric: () => DerivedRubric | null;
  setDerivedRubric: (r: DerivedRubric | null) => void;
  setStartedAt: (ts: number) => void;
  getMultiWriter: () => MultiWriterState | undefined;
  setMultiWriter: (mw: MultiWriterState | undefined) => void;
  setRound: (r: number) => void;
  getActualRoundsCompleted: () => number;
  setActualRoundsCompleted: (n: number) => void;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string, summary?: unknown) => void;
  setPhase: (p: SwarmPhase) => void;
  runOne: (agent: Agent, prompt: string, label: string) => Promise<string>;
  runAggregatorSelfCritique: (
    agg: Agent,
    synthesis: string,
    proposals: ReadonlyArray<{ workerId: string; text: string }>,
  ) => Promise<string>;
  runAggregationTree: (input: {
    seed: string;
    initialInputs: ReadonlyArray<{ workerId: string; text: string }>;
    levels: number;
    availableAggregators: readonly Agent[];
  }) => Promise<{ text: string; layerSizes: number[] }>;
  getRunId?: () => string | undefined;
  getBrainService?: () =>
    | { injectSuggestion?: (runId: string, s: { title: string; text: string; category?: string }) => void }
    | null
    | undefined;
}

export async function runMoaLoopBody(
  host: MoaLoopBodyHost,
  cfg: RunConfig,
): Promise<void> {
  const spawned = await moaCloneAndSpawn(
    {
      repos: host.repos,
      manager: host.manager,
      emit: (e) => host.emit(e),
      appendSystem: (t) => host.appendSystem(t),
      setPhase: (p) => host.setPhase(p),
      getStopping: () => host.getStopping(),
    },
    cfg,
  );
  if (!spawned) return;
  const { destPath, proposers, aggregators } = spawned;
  const proposerCount = proposers.length;

  const directive = (cfg.userDirective ?? "").trim();
  const seed = directive.length > 0
    ? `User directive: ${directive}`
    : "No user directive supplied. Discuss the most useful thing to do with this codebase.";

  const repoFiles = await host.repos.listRepoFiles(destPath, { maxFiles: 50 });
  const readme = await host.repos.readReadme(destPath);

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
      host.appendSystem(
        `Pre-fetched ${repoExcerpts.length} file excerpt(s) for proposer grounding: ${repoExcerpts.map((e) => e.path).join(", ")}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    host.appendSystem(`Context gather failed (${msg}); proposers will work with file names only.`);
  }

  // 2026-05-02 (quality lever #2): derive a per-run rubric BEFORE
  // the discussion loop. First aggregator (or first proposer if no
  // aggregator) runs the derivation. Best-effort.
  const rubricAgent = aggregators[0] ?? proposers[0];
  if (rubricAgent && cfg.userDirective) {
    host.appendSystem(`Deriving success rubric from directive (lever #2)…`);
    const derived = await deriveRubric({
      agent: rubricAgent,
      manager: host.manager,
      directive: cfg.userDirective,
    });
    host.setDerivedRubric(derived);
    host.appendSystem(
      `Rubric derived: ${derived.criteria.length} criteria, shape "${derived.deliverableShape}".`,
    );
    // 2026-05-02 (matrix row #1): advisory auto-tune. Compute the
    // proposer count this rubric warrants; surface a recommendation
    // when it differs from what's actually configured. We don't
    // re-spawn mid-run — that's bigger structural work — but
    // surfacing the gap closes the "how many proposers should I
    // have used?" question the user otherwise discovers post-hoc.
    const recommendedCount = recommendProposerCount(derived);
    if (recommendedCount !== proposerCount) {
      host.appendSystem(
        `[advisory] Rubric complexity suggests ${recommendedCount} proposer${recommendedCount === 1 ? "" : "s"} (currently ${proposerCount}). Consider re-running with agentCount=${recommendedCount} for next time; this run continues with ${proposerCount}.`,
      );
    }
  }

  host.setPhase("discussing");
  host.setStartedAt(Date.now());

  // Phase 2 (writeMode: multi): initialize multi-writer state
  if (cfg.writeMode === "multi") {
    host.setMultiWriter(new MultiWriterState({
      writeMode: cfg.writeMode,
      conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["moa"],
      clonePath: destPath,
    }));
    host.appendSystem(
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
    thresholdForDeliverableShape(host.getDerivedRubric()?.deliverableShape);
  // 2026-05-03 (post-Phase-D follow-up): budget + quota guard parity
  // with the other 8 runners. Pre-fix MoA was the only preset that
  // could blow past cfg.tokenBudget without halting (audit Pattern 2a).
  const tokenBaseline = snapshotLifetimeTokens();
  // Empty/junk proposals only (similar proposer drafts are expected).
  const deadLoopGuard = new OutputEmptyDeadLoopGuard({
    roleLabel: "proposers",
    unit: "round",
  });
  for (let round = 1; round <= rounds; round++) {
    if (host.getStopping()) break;
    if (host.getDrainRequested?.() && round > 1) {
      host.appendSystem(`[drain] Soft stop — ending MoA after round ${round - 1}.`);
      host.setEarlyStopDetail("user-drain: finished current round");
      break;
    }
    const guard = checkBudgetGuards({
      tokenBaseline,
      tokenBudget: cfg.tokenBudget,
      round,
      totalRounds: rounds,
      runId: cfg.runId,
      unit: "round",
    });
    if (guard.halt) {
      host.setEarlyStopDetail(guard.earlyStopDetail);
      host.appendSystem(guard.message ?? "");
      break;
    }
    host.setRound(round);
    host.setActualRoundsCompleted(round);
    host.appendSystem(`── MoA Round ${round}/${rounds} — Layer 1: ${proposerCount} proposers (peer-hidden) ──`);

    const transcriptLenBefore = host.transcript.length;

    // #119 + 2026-05-02 (chat lever #3): pull user-role transcript
    // entries each round so chat injections reach agents. PER-AGENT
    // filter via userEntryVisibleTo honors @mention routing — a
    // user message tagged targetAgent="agent-2" lands ONLY in
    // agent-2's prompt, not the other proposers'. Broadcast messages
    // (no targetAgent) reach everyone.
    const userEntries = host.transcript.filter((e) => e.role === "user");

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
        return host.runOne(agent, proposerPrompt, `proposer-${idx + 1}`).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          host.appendSystem(`[${agent.id}] proposer prompt failed: ${msg}`);
          return null;
        });
      }),
    );
    if (host.getStopping()) return;

    const validProposals = proposals
      .map((p, idx) => (p ? { workerId: proposers[idx].id, text: p } : null))
      .filter((p): p is { workerId: string; text: string } => p !== null);

    if (validProposals.length === 0) {
      host.appendSystem(`MoA round ${round}: all ${proposerCount} proposers failed; aborting.`);
      host.setPhase("failed");
      return;
    }

    // Empty/junk transcript turns only (similar proposal text is expected).
    const newEntries = host.transcript
      .slice(transcriptLenBefore)
      .filter((e) => e.role === "agent");
    const dlHit = deadLoopGuard.recordIteration(newEntries);
    if (dlHit.tripped) {
      host.setEarlyStopDetail(dlHit.earlyStopDetail);
      host.appendSystem(
        `All proposers produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending MoA early.`,
      );
      notifyGuardTrip({
        kind: "output-empty",
        detail: dlHit.earlyStopDetail ?? "proposers-silenced",
        runId: host.getRunId?.() ?? cfg.runId,
        appendSystem: (t, s) => host.appendSystem(t, s),
        getBrainService: host.getBrainService,
      });
      break;
    }

    // #93 deeper (2026-05-01): K aggregators in parallel + central pick.
    // Each aggregator gets a slightly different system-prompt variation
    // (clarity / completeness / actionability). When K=1, the rotation
    // collapses to the canonical prompt = current behavior.
    host.appendSystem(
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
        return host.runOne(agg, synthPrompt, `aggregator-${idx + 1}-${variant}`)
          .then((text) => ({ ok: true as const, idx, text, agg }))
          .catch((err) => ({ ok: false as const, idx, err, agg }));
      }),
    );
    if (host.getStopping()) return;

    const validSyntheses = synthResults.filter(
      (r): r is { ok: true; idx: number; text: string; agg: Agent } => r.ok,
    );
    if (validSyntheses.length === 0) {
      host.appendSystem(`MoA round ${round}: all ${aggregators.length} aggregator(s) failed; aborting.`);
      host.setPhase("failed");
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
          const critiqued = await host.runAggregatorSelfCritique(
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
      host.appendSystem(
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
        const treeResult = await host.runAggregationTree({
          seed,
          initialInputs: validSyntheses.map((s, i) => ({
            workerId: `aggregator-${i + 1}`,
            text: s.text,
          })),
          levels: requestedLevels,
          availableAggregators: aggregators,
        });
        if (treeResult.text && treeResult.text.trim().length > 0) {
          host.appendSystem(
            `[T199 multi-tier MoA] ${requestedLevels}-level aggregation tree completed (${validSyntheses.length} L0 → ${treeResult.layerSizes.slice(1).join(" → ")} → 1).`,
          );
          synthesis = treeResult.text;
        } else {
          host.appendSystem(
            `[T199 multi-tier MoA] tree produced empty top synthesis — falling back to single-pick winner.`,
          );
        }
      } catch (err) {
        host.appendSystem(
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
          host.appendSystem(
            `[issue #1] Challenger telemetry: REDUNDANT — challenger draft had no tokens unique vs other proposers. (ratio=null)`,
          );
        } else {
          host.appendSystem(
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
      synthesis = await host.runAggregatorSelfCritique(
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
      const ollamaBaseUrl = host.ollamaBaseUrl;
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
      host.appendSystem(
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
        host.appendSystem(
          `[T189 aggregator-confidence override] Aggregator self-reported CONFIDENCE: low; ignoring convergence signal and forcing another round (round ${round + 1}/${rounds}).`,
        );
        converged = false;
      } else if (aggConfidence === "low") {
        host.appendSystem(
          `[T189 aggregator-confidence] CONFIDENCE: low this round but no more rounds available — synthesis lands as-is. Consider increasing rounds or providing more context.`,
        );
      }
      if (converged) {
        host.appendSystem(
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
    if (round < rounds && !host.getStopping()) {
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
          host.appendSystem(
            `[issue #5] Round ${round + 1} additive gather: +${additional.length} new file excerpt${additional.length === 1 ? "" : "s"} (${additional.map((e) => e.path).join(", ")}); total ${repoExcerpts.length} (was ${before}).`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        host.appendSystem(`Mid-run gather failed (${msg}); proposers will continue with prior excerpts.`);
      }
    }
  }

  host.appendSystem(`MoA finished after ${host.getActualRoundsCompleted()} round(s) (capped at ${rounds}).`);

  // Phase 2 (writeMode: multi): reconcile proposals if multi-writer active
  const multiWriter = host.getMultiWriter();
  if (multiWriter?.isActive() && multiWriter.proposalCount() > 0) {
    const proposals = multiWriter.getProposals();
    host.appendSystem(
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
    const result = await multiWriter.reconcile(currentFiles, strategy);

    if (!result.ok) {
      host.appendSystem(
        `Multi-writer reconcile: failed — ${result.conflicts.length} conflict(s) detected.`,
      );
      for (const conflict of result.conflicts.slice(0, 5)) {
        host.appendSystem(
          `  ${conflict.type} on ${conflict.file}: ${conflict.conflictingAgents.map(a => `agent-${a.agentIndex}`).join(", ")}`,
        );
      }
    } else if (result.hunks.length > 0) {
      host.appendSystem(
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
        repos: host.repos,
        manager: host.manager,
        emit: host.emit,
        appendSystem: (text) => host.appendSystem(text),
        presetName: "moa",
        verifyCommand: cfg.verifyCommand,
        hunksFromSynthesizer: result.hunks,
      });

      if (applyResult.ok) {
        host.appendSystem(
          `Multi-writer apply: ${applyResult.hunksApplied}/${applyResult.hunksAttempted} hunk(s) committed (${applyResult.commitSha?.slice(0, 7)}).`,
        );
      } else {
        host.appendSystem(
          `Multi-writer apply: failed — ${applyResult.reason}`,
        );
      }
    } else {
      host.appendSystem(`Multi-writer reconcile: 0 hunks to apply.`);
    }
  }

  // setPhase("completed") + killAll happen in loop()'s finally block.
}
