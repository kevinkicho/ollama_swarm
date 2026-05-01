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
    // Spawn N proposers + 1 aggregator. Aggregator is the LAST agent
    // (highest index) so per-agent panel rendering shows proposers in
    // order then the aggregator. The N count comes from cfg.agentCount;
    // the aggregator is in addition (not subtracted) so the user's
    // "5 agents" gets 5 proposers + 1 aggregator = 6 total.
    const proposerCount = cfg.agentCount;
    const totalAgents = proposerCount + 1;
    const agents: Agent[] = [];
    for (let i = 1; i <= totalAgents; i++) {
      const agent = await this.opts.manager.spawnAgentNoOpencode({
        cwd: destPath,
        index: i,
        model: cfg.model,
      });
      agents.push(agent);
      if (this.stopping) return;
    }
    const proposers = agents.slice(0, proposerCount);
    const aggregator = agents[agents.length - 1];
    this.appendSystem(
      `MoA ready: ${proposerCount} proposer(s) + 1 aggregator (${aggregator.id})`,
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
    for (let round = 1; round <= rounds; round++) {
      this.round = round;
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

      this.appendSystem(`── Layer 2: aggregator synthesizing ${validProposals.length}/${proposerCount} proposals ──`);

      const synthPrompt = buildAggregatorPrompt({ seed, proposals: validProposals });
      let synthesis: string;
      try {
        synthesis = await this.runOne(aggregator, synthPrompt, "aggregator");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`[${aggregator.id}] aggregator failed: ${msg}`);
        this.setPhase("failed");
        return;
      }
      if (this.stopping) return;

      priorSynthesis = synthesis;
    }

    this.appendSystem(`MoA finished after ${rounds} round(s).`);
    this.setPhase("completed");
  }

  /** One prompt → cleaned text. Records the agent message in the
   *  transcript. Throws on transport errors so the caller can decide
   *  whether to abort the whole round. */
  private async runOne(agent: Agent, prompt: string, label: string): Promise<string> {
    const ctrl = new AbortController();
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

export interface AggregatorPromptInput {
  seed: string;
  proposals: ReadonlyArray<{ workerId: string; text: string }>;
}

export function buildAggregatorPrompt(input: AggregatorPromptInput): string {
  const parts: string[] = [];
  parts.push(
    "You are the aggregator on a Mixture-of-Agents team. You see N independent proposers' answers to the same seed. Synthesize a single coherent answer that:",
  );
  parts.push("  - Surfaces the points multiple proposers agreed on (those are the most reliable signal).");
  parts.push("  - Notes where proposers disagreed, and pick the strongest argument for each side.");
  parts.push("  - Drops ideas only one proposer mentioned UNLESS they're clearly correct on technical merit.");
  parts.push("  - Produces ONE answer, not N answers stitched together.");
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
