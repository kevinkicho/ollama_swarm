// Q11 (2026-05-04): hunk placement RAG for blackboard.
//
// `.swarm-memory.jsonl` records lessons per past run. When a worker
// is about to emit hunks for a NEW todo, retrieve similar past
// successful hunks and surface them as few-shot examples — so the
// model has concrete patterns to follow instead of inventing fresh.
//
// "Similar" is computed by lightweight token-overlap (Jaccard) on
// the todo descriptions + expectedFiles. Embedding-based RAG would
// be more accurate but adds a dep + per-call latency; the token-
// overlap path is good enough as a first cut and keeps the helper
// pure (no I/O during scoring).
//
// Pure helpers:
//   - `tokenize` — lowercase + split on non-alphanum + drop short tokens
//   - `jaccardSimilarity` — pure set operation over token bags
//   - `selectSimilarHunks` — top-N picker; the runner threads the
//     candidate pool from `.swarm-memory.jsonl` + similar workspaces
//
// Tradeoffs:
//   - Specific to repos with prior runs. Empty memory file → no-op.
//   - Token-overlap mis-scores semantically-similar-but-lexically-
//     different cases (e.g., "rename function" vs "extract helper"
//     might score low even if the hunk shape is similar). Embeddings
//     would help but add weight.
//   - Few-shot biases the model toward the historical patterns. For
//     repos that are evolving rapidly, this can entrench out-of-date
//     conventions. Cap at top-3 to limit the bias.

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "for", "on", "at",
  "by", "from", "with", "is", "are", "was", "were", "be", "been", "this",
  "that", "these", "those", "it", "its", "as", "if", "we", "you", "i",
]);

/** Lowercase + split on non-alphanumeric + drop stop words +
 *  drop tokens shorter than 3 chars. Pure. */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity = |A ∩ B| / |A ∪ B|. Range [0, 1]. Pure.
 *  Returns 0 when both sets are empty (defensive — avoid 0/0). */
export function jaccardSimilarity(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface PastHunkExample {
  /** The original todo description that produced the hunk. */
  todoDescription: string;
  /** Files the hunk targeted. */
  expectedFiles: readonly string[];
  /** The hunk-emit response text (or a serialized form). */
  hunkResponse: string;
  /** Optional context: which run, when. */
  runId?: string;
  ts?: number;
}

/** Score + return the top-N most-similar past hunks for a query
 *  todo. Pure — exported for tests; the runner threads the
 *  candidates from `.swarm-memory.jsonl` (or wherever past hunks
 *  are persisted). */
export function selectSimilarHunks(args: {
  query: { description: string; expectedFiles: readonly string[] };
  candidates: readonly PastHunkExample[];
  /** Max N few-shot examples to return. Default 3. */
  maxResults?: number;
  /** Min similarity to consider (avoids surfacing noise). Default 0.1. */
  minSimilarity?: number;
}): Array<{ example: PastHunkExample; similarity: number }> {
  const max = args.maxResults ?? 3;
  const min = args.minSimilarity ?? 0.1;
  const queryTokens = tokenize(
    args.query.description + " " + args.query.expectedFiles.join(" "),
  );
  const scored = args.candidates.map((c) => {
    const candTokens = tokenize(
      c.todoDescription + " " + c.expectedFiles.join(" "),
    );
    return { example: c, similarity: jaccardSimilarity(queryTokens, candTokens) };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.filter((s) => s.similarity >= min).slice(0, max);
}

/** Render the few-shot examples as a worker-prompt block. Empty
 *  array → empty string. Pure. */
export function buildHunkRagPromptBlock(
  examples: ReadonlyArray<{ example: PastHunkExample; similarity: number }>,
): string {
  if (examples.length === 0) return "";
  const lines: string[] = [
    "=== Few-shot: similar hunks from past successful runs on this repo ===",
    "These are previous (todo, hunk-response) pairs that succeeded. Use them as STYLE GUIDE — not as a verbatim template (your todo is different).",
    "",
  ];
  examples.forEach((e, i) => {
    const sim = e.similarity.toFixed(2);
    lines.push(`--- Example ${i + 1} (similarity ${sim}) ---`);
    lines.push(`Todo: ${e.example.todoDescription.trim()}`);
    if (e.example.expectedFiles.length > 0) {
      lines.push(`Files: ${e.example.expectedFiles.join(", ")}`);
    }
    lines.push("Response:");
    lines.push(e.example.hunkResponse.trim().slice(0, 1500));
    lines.push("");
  });
  lines.push("=== End few-shot examples ===");
  return lines.join("\n");
}
