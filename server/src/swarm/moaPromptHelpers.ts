// #88 (2026-05-01): Pure prompt builders + helper functions extracted from
// MoaRunner. All are pure — no `this`, no dependencies on the runner instance.

import type { Agent } from "../services/AgentManager.js";

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