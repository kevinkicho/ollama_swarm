// 2026-05-02 (issue #4 fix): semantic convergence via embeddings.
// Replaces Jaccard's word-overlap signal (which is semantically blind:
// two syntheses can say the same thing in different words → low Jaccard
// → "diverse" → keep iterating wastefully; or say opposite things with
// the same vocabulary → high Jaccard → "converged" → stop early on
// contradiction).
//
// Embedding-based convergence:
//   1. Embed prior + current synthesis via Ollama (same /api/embed
//      endpoint EmbeddingDriftMonitor uses)
//   2. Compute cosine similarity (range [-1, 1] but practically [0, 1]
//      for natural text)
//   3. Compare against threshold; default 0.85 (more conservative than
//      Jaccard's 0.7 because cosine on embeddings is denser)
//
// Best-effort: when the embedding model isn't pulled OR the call fails,
// returns null → caller falls back to Jaccard. Dependency-light: reuses
// EmbeddingDriftMonitor's embedText + cosineSimilarity, no new infra.

import { embedText, cosineSimilarity } from "../services/EmbeddingDriftMonitor.js";

const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_THRESHOLD = 0.85;

export interface SemanticConvergenceVerdict {
  converged: boolean;
  similarity: number;
  threshold: number;
  signal: "embedding";
}

/** Detect convergence via embedding cosine similarity. Returns null
 *  when the embedding model is unavailable so the caller can fall back
 *  to Jaccard. Best-effort across the network call.
 *
 *  Per-task threshold note: this module uses a single default (0.85);
 *  per-task tuning lives in the caller via the threshold param —
 *  same shape as detectConvergence in moaConsensus.ts so they're
 *  swappable. */
export async function detectSemanticConvergence(input: {
  prior: string;
  current: string;
  ollamaBaseUrl: string;
  threshold?: number;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<SemanticConvergenceVerdict | null> {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const model = input.model ?? DEFAULT_EMBED_MODEL;
  const fetchImpl = input.fetchImpl ?? fetch;
  // Empty inputs → treat as identical (matches Jaccard semantics).
  if (input.prior.trim().length === 0 && input.current.trim().length === 0) {
    return { converged: true, similarity: 1, threshold, signal: "embedding" };
  }
  if (input.prior.trim().length === 0 || input.current.trim().length === 0) {
    return { converged: false, similarity: 0, threshold, signal: "embedding" };
  }
  let priorVec: number[];
  let currentVec: number[];
  try {
    [priorVec, currentVec] = await Promise.all([
      embedText({ text: input.prior, baseUrl: input.ollamaBaseUrl, model, fetchImpl }),
      embedText({ text: input.current, baseUrl: input.ollamaBaseUrl, model, fetchImpl }),
    ]);
  } catch {
    // Embedding model not pulled / network failure / etc. — caller
    // falls back to Jaccard.
    return null;
  }
  let similarity: number;
  try {
    similarity = cosineSimilarity(priorVec, currentVec);
  } catch {
    return null;
  }
  return {
    converged: similarity >= threshold,
    similarity,
    threshold,
    signal: "embedding",
  };
}

/** Map the Jaccard-tuned thresholds (0.7 / 0.4 / 0.5) to embedding-tuned
 *  thresholds. Embeddings on natural text cluster much higher than
 *  Jaccard (0.7 cosine ≈ 0.4 Jaccard for similar-meaning text), so
 *  the bands shift. Pure — exported for tests. */
export function jaccardToCosineThreshold(jaccardThreshold: number): number {
  // Empirical mapping based on natural-language paragraph pairs:
  //   Jaccard 0.4 (debate/decision)   ≈ cosine 0.78
  //   Jaccard 0.5 (exploration)       ≈ cosine 0.82
  //   Jaccard 0.7 (analysis/report)   ≈ cosine 0.88
  if (jaccardThreshold <= 0.4) return 0.78;
  if (jaccardThreshold <= 0.5) return 0.82;
  if (jaccardThreshold <= 0.7) return 0.88;
  return 0.92; // very strict
}
