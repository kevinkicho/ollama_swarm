// #93 deeper (2026-05-01): pure helpers for MoA convergence detection
// + multi-aggregator picking.
//
// Both use a token-set Jaccard similarity as the cheap-but-honest
// signal. For two synthesized texts that say substantially the same
// thing, Jaccard ≥ 0.7 is a reasonable "converged enough" threshold.
// Future iteration could swap in embedding cosine for sharper signal,
// but Jaccard is dependency-free and fast.

/** Tokenize for similarity: lowercase, split on non-word chars, drop
 *  empties + single chars (those carry no signal). */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

/** Jaccard similarity = |A ∩ B| / |A ∪ B|. Range [0, 1]. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1; // both empty = trivially identical
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export interface ConvergenceVerdict {
  converged: boolean;
  similarity: number;
  threshold: number;
}

/** 2026-05-02 (matrix row #5): per-task-class default thresholds.
 *  Different task shapes warrant different convergence thresholds —
 *  analysis tasks SHOULD converge fast (proposers reading the same
 *  README will land on similar audits); debate tasks SHOULD resist
 *  convergence (the whole point is to surface tradeoffs, not collapse
 *  to one view). The runner picks a default based on the rubric's
 *  deliverableShape; user-supplied moaConvergenceThreshold always wins. */
const TASK_CLASS_THRESHOLDS: Record<string, number> = {
  analysis: 0.7,    // README audits, code reviews — fast convergence is OK
  decision: 0.4,    // Express vs Fastify — should NOT collapse early
  debate: 0.4,      // adversarial framing — keep tension alive
  report: 0.7,      // coverage maps, walkthroughs — converge naturally
  walkthrough: 0.7,
  exploration: 0.5, // novel ideas — middle ground
};

/** Pick a convergence threshold from the deliverable shape descriptor.
 *  Falls back to 0.7 (the historical default) when no class matches.
 *  Pure — exported for tests. */
export function thresholdForDeliverableShape(shape: string | undefined): number {
  if (!shape) return 0.7;
  const lower = shape.toLowerCase();
  for (const [taskClass, threshold] of Object.entries(TASK_CLASS_THRESHOLDS)) {
    if (lower.includes(taskClass)) return threshold;
  }
  return 0.7;
}

/** Decide whether round N synthesis converges with round N-1. Default
 *  threshold 0.7 — empirically MoA rounds 2+ usually settle here when
 *  the proposers and aggregator agree. */
export function detectConvergence(
  prior: string,
  current: string,
  threshold: number = 0.7,
): ConvergenceVerdict {
  const sim = jaccardSimilarity(prior, current);
  return {
    converged: sim >= threshold,
    similarity: sim,
    threshold,
  };
}

/** Pick the "most central" candidate from K aggregator outputs — the
 *  one with the highest mean Jaccard similarity to the others. The
 *  intuition: a synthesis that's similar to all the others captures
 *  what the aggregators agree on; an outlier synthesis is by
 *  definition saying something the others didn't. */
export interface CentralVerdict {
  /** Index of the picked candidate in the input array. */
  winnerIdx: number;
  /** Mean Jaccard of winner against all other candidates. */
  meanSimilarity: number;
  /** Per-candidate mean similarity, useful for diagnostics. */
  perCandidateMean: number[];
}

// 2026-05-02 (issue #1 fix): challenger substantiveness scoring.
// The challenger proposer (matrix row #2) is auto-designated as the
// last proposer in the round. Without this metric we can't tell
// whether the challenger added meaningful dissent OR just manufactured
// disagreement to comply with the red-team prompt.
//
// Heuristic: count tokens in the challenger's draft that don't appear
// in any other proposer's draft (the challenger's UNIQUE contribution),
// then check how many of those made it into the synthesis (the
// aggregator's WEIGHTING of that contribution).
//
//   substantiveness = |challengerUnique ∩ synthesisTokens| / |challengerUnique|
//
// Range [0, 1]. Higher = more challenger contribution survived the
// aggregation. Pure — exported for tests.
//
// Calibration:
//   ≥ 0.30 — substantive (challenger raised real points the synthesis kept)
//   0.10–0.30 — marginal (some points kept, mostly discarded)
//   < 0.10 — noise (challenger contributed nothing the aggregator weighted)
//
// Returns null when |challengerUnique| === 0 (challenger said the same
// things as peers — neither substantive nor noise, just redundant).
export interface ChallengerSubstantiveness {
  /** [0, 1] ratio; null when no unique contribution exists. */
  ratio: number | null;
  /** Bucket for at-a-glance reading. */
  bucket: "substantive" | "marginal" | "noise" | "redundant";
  /** Diagnostics. */
  uniqueTokenCount: number;
  incorporatedTokenCount: number;
}

export function scoreChallengerSubstantiveness(input: {
  challengerDraft: string;
  otherDrafts: readonly string[];
  synthesis: string;
}): ChallengerSubstantiveness {
  const challengerTokens = tokenize(input.challengerDraft);
  if (challengerTokens.size === 0) {
    return { ratio: null, bucket: "redundant", uniqueTokenCount: 0, incorporatedTokenCount: 0 };
  }
  // Union of all OTHER proposers' tokens.
  const otherTokens = new Set<string>();
  for (const draft of input.otherDrafts) {
    for (const t of tokenize(draft)) otherTokens.add(t);
  }
  // Tokens unique to the challenger (in challenger but not in any other).
  const uniqueToChallenger = new Set<string>();
  for (const t of challengerTokens) {
    if (!otherTokens.has(t)) uniqueToChallenger.add(t);
  }
  if (uniqueToChallenger.size === 0) {
    return { ratio: null, bucket: "redundant", uniqueTokenCount: 0, incorporatedTokenCount: 0 };
  }
  // Of those unique tokens, how many made it into the synthesis?
  const synthesisTokens = tokenize(input.synthesis);
  let incorporated = 0;
  for (const t of uniqueToChallenger) {
    if (synthesisTokens.has(t)) incorporated += 1;
  }
  const ratio = incorporated / uniqueToChallenger.size;
  let bucket: ChallengerSubstantiveness["bucket"];
  if (ratio >= 0.3) bucket = "substantive";
  else if (ratio >= 0.1) bucket = "marginal";
  else bucket = "noise";
  return {
    ratio,
    bucket,
    uniqueTokenCount: uniqueToChallenger.size,
    incorporatedTokenCount: incorporated,
  };
}

export function pickMostCentralAggregator(candidates: readonly string[]): CentralVerdict {
  if (candidates.length === 0) {
    throw new Error("pickMostCentralAggregator: candidates must be non-empty");
  }
  if (candidates.length === 1) {
    return { winnerIdx: 0, meanSimilarity: 1, perCandidateMean: [1] };
  }
  const perCandidateMean: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      sum += jaccardSimilarity(candidates[i], candidates[j]);
      n += 1;
    }
    perCandidateMean.push(n > 0 ? sum / n : 0);
  }
  // Pick the index with the highest mean. Ties → lowest index (deterministic).
  let winnerIdx = 0;
  let bestMean = perCandidateMean[0];
  for (let i = 1; i < perCandidateMean.length; i++) {
    if (perCandidateMean[i] > bestMean) {
      bestMean = perCandidateMean[i];
      winnerIdx = i;
    }
  }
  return { winnerIdx, meanSimilarity: bestMean, perCandidateMean };
}
