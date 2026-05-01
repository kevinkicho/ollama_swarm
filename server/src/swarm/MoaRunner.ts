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
import { describeSdkError } from "./sdkError.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { detectConvergence, pickMostCentralAggregator } from "./moaConsensus.js";

export class MoaRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private startedAt?: number;

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

  injectUser(text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "user", text, ts: Date.now() };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
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

    void this.loop(cfg).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`MoA crashed: ${msg}`);
      this.setPhase("failed");
    });
  }

  private async loop(cfg: RunConfig): Promise<void> {
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
    const proposerModel = cfg.moaProposerModel ?? cfg.model;
    const aggregatorModel = cfg.moaAggregatorModel ?? cfg.model;
    const agents: Agent[] = [];
    for (let i = 1; i <= totalAgents; i++) {
      const isAggregator = i > proposerCount;
      const model = isAggregator ? aggregatorModel : proposerModel;
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

    const directive = (cfg.userDirective ?? "").trim();
    const seed = directive.length > 0
      ? `User directive: ${directive}`
      : "No user directive supplied. Discuss the most useful thing to do with this codebase.";

    const repoFiles = await this.opts.repos.listRepoFiles(destPath, { maxFiles: 50 });
    const readme = await this.opts.repos.readReadme(destPath);

    this.setPhase("discussing");
    this.startedAt = Date.now();

    let priorSynthesis: string | null = null;
    const rounds = Math.max(1, Math.min(10, cfg.rounds ?? 1));
    const convergenceThreshold = cfg.moaConvergenceThreshold ?? 0.7;
    let actualRoundsRun = 0;
    for (let round = 1; round <= rounds; round++) {
      this.round = round;
      actualRoundsRun = round;
      this.appendSystem(`── MoA Round ${round}/${rounds} — Layer 1: ${proposerCount} proposers (peer-hidden) ──`);

      const proposerPrompt = buildProposerPrompt({
        seed,
        repoFiles,
        readme,
        priorSynthesis,
      });

      // Layer 1: parallel, peer-hidden proposers.
      const proposals = await Promise.all(
        proposers.map((agent, idx) =>
          this.runOne(agent, proposerPrompt, `proposer-${idx + 1}`).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.appendSystem(`[${agent.id}] proposer prompt failed: ${msg}`);
            return null;
          }),
        ),
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
          const synthPrompt = buildAggregatorPrompt({
            seed,
            proposals: validProposals,
            variantBias: variant,
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

      let synthesis: string;
      if (validSyntheses.length === 1) {
        synthesis = validSyntheses[0].text;
      } else {
        const central = pickMostCentralAggregator(validSyntheses.map((s) => s.text));
        synthesis = validSyntheses[central.winnerIdx].text;
        this.appendSystem(
          `[multi-aggregator] ${validSyntheses.length}/${aggregators.length} synthesized · winner=aggregator-${central.winnerIdx + 1} · meanJaccard=${central.meanSimilarity.toFixed(3)}` +
            ` · perCandidate=[${central.perCandidateMean.map((m) => m.toFixed(2)).join(", ")}]`,
        );
      }

      // #93 deeper: convergence detection. After round 2+, check if the
      // new synthesis is similar enough to the prior round's that we can
      // stop early. Saves rounds × (proposer + K aggregator) calls.
      if (priorSynthesis !== null) {
        const verdict = detectConvergence(priorSynthesis, synthesis, convergenceThreshold);
        this.appendSystem(
          `[convergence] round ${round} vs ${round - 1}: jaccard=${verdict.similarity.toFixed(3)} threshold=${verdict.threshold} converged=${verdict.converged}`,
        );
        if (verdict.converged) {
          this.appendSystem(
            `MoA converged after round ${round} (similarity ${verdict.similarity.toFixed(3)} ≥ ${verdict.threshold}); stopping early.`,
          );
          priorSynthesis = synthesis;
          break;
        }
      }

      priorSynthesis = synthesis;
    }

    this.appendSystem(`MoA finished after ${actualRoundsRun} round(s) (capped at ${rounds}).`);
    this.setPhase("completed");
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
  private async runOne(agent: Agent, prompt: string, label: string): Promise<string> {
    const ctrl = new AbortController();
    const startedAt = Date.now();
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState(agent, "thinking", startedAt);
    try {
      const res = (await promptWithRetry(agent, prompt, {
        signal: ctrl.signal,
        manager: this.opts.manager,
        formatExpect: "free",
        describeError: (e) => describeSdkError(e),
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

  private appendSystem(text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now() };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }
}

// ---------------------------------------------------------------------------
// Pure prompt builders — exported for tests.
// ---------------------------------------------------------------------------

export interface ProposerPromptInput {
  seed: string;
  repoFiles: readonly string[];
  readme: string | null;
  /** Set on round 2+ — the prior round's aggregator synthesis. Lets
   *  proposers ground their fresh draft on what the team converged on
   *  last time without polluting layer-1 independence within a round. */
  priorSynthesis: string | null;
}

export function buildProposerPrompt(input: ProposerPromptInput): string {
  const parts: string[] = [];
  parts.push(
    "You are one of N independent agents on a Mixture-of-Agents team. Respond to the seed below with your own analysis. You CANNOT see what other agents on this round wrote — that's intentional. Do your own thinking.",
  );
  parts.push("Your response will be aggregated with N-1 peers' responses; the aggregator looks for agreement and synthesizes.");
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
  if (input.priorSynthesis) {
    parts.push("");
    parts.push("Prior round's aggregated synthesis (you may build on or disagree with this):");
    parts.push(input.priorSynthesis.slice(0, 4000));
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
  parts.push("");
  parts.push(`Proposers (${input.proposals.length}):`);
  for (const [i, p] of input.proposals.entries()) {
    parts.push("");
    parts.push(`--- Proposer ${i + 1} (${p.workerId}) ---`);
    parts.push(p.text.slice(0, 4000));
  }
  parts.push("");
  parts.push("Your synthesized answer (under 600 words, plain prose):");
  return parts.join("\n");
}
