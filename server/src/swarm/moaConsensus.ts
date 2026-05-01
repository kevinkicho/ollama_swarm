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
