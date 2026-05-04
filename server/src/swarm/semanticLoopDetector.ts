// R9 (2026-05-04): semantic-loop detector.
//
// Distinct from semanticConvergence.ts: that module asks "did the
// CURRENT synthesis match the PRIOR one?" (a good sign — caller stops
// early on agreement). This one asks "are the last K turns all
// repeating each other?" (a bad sign — swarm is stuck in a circle).
//
// Implementation: Jaccard similarity on lowercased word sets (no
// embedding round-trip needed; runs cheap inline between turns). When
// every pairwise Jaccard among the last K turns exceeds the threshold,
// we've detected a loop.
//
// Pure: no I/O. Returns a verdict the caller can use to abort the run
// or inject a "you're going in circles, change strategy" amendment.

export const DEFAULT_LOOP_WINDOW = 4;
export const DEFAULT_LOOP_SIMILARITY = 0.7;

export interface LoopVerdict {
  /** True when every pair in the window meets the threshold. */
  inLoop: boolean;
  /** Smallest pairwise similarity in the window — high means tight
   *  loop; low means at least one turn broke the pattern. */
  minPairwiseSimilarity: number;
  /** Window size actually evaluated. May be smaller than `window`
   *  when the caller hasn't accumulated K turns yet. */
  windowSize: number;
  /** Plain-English message for the transcript / amendment. */
  reason: string;
}

export interface LoopDetectorInput {
  /** Recent turn texts, oldest → newest. The detector evaluates the
   *  last `window` entries. */
  recentTurns: readonly string[];
  /** Number of consecutive turns to compare. Default 4. */
  window?: number;
  /** Minimum pairwise Jaccard for a "loop". Default 0.7. */
  threshold?: number;
}

export function detectSemanticLoop(input: LoopDetectorInput): LoopVerdict {
  const {
    recentTurns,
    window = DEFAULT_LOOP_WINDOW,
    threshold = DEFAULT_LOOP_SIMILARITY,
  } = input;
  if (window < 2) {
    return {
      inLoop: false,
      minPairwiseSimilarity: 1,
      windowSize: 0,
      reason: "window < 2 — not enough turns to compare",
    };
  }
  if (recentTurns.length < window) {
    return {
      inLoop: false,
      minPairwiseSimilarity: 1,
      windowSize: recentTurns.length,
      reason: `only ${recentTurns.length} turns available (need ${window})`,
    };
  }
  const slice = recentTurns.slice(-window);
  const tokenSets = slice.map(toTokenSet);
  let minSim = 1;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const sim = jaccard(tokenSets[i], tokenSets[j]);
      if (sim < minSim) minSim = sim;
    }
  }
  const inLoop = minSim >= threshold;
  return {
    inLoop,
    minPairwiseSimilarity: minSim,
    windowSize: window,
    reason: inLoop
      ? `last ${window} turns all share ≥${threshold.toFixed(2)} word overlap (min=${minSim.toFixed(2)}) — likely loop`
      : `last ${window} turns vary enough (min pairwise=${minSim.toFixed(2)}, threshold=${threshold.toFixed(2)})`,
  };
}

/** Lowercase + word-tokenize + dedupe. */
export function toTokenSet(text: string): Set<string> {
  if (!text) return new Set();
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens);
}

/** Jaccard similarity between two token sets — |A ∩ B| / |A ∪ B|.
 *  Both empty → 1 (treated as identical). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  // Iterate the smaller set to keep it O(min(|a|,|b|)).
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of smaller) if (larger.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 1 : intersect / union;
}
