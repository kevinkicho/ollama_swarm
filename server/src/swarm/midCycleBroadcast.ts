// Q9 (2026-05-04): mid-cycle finding broadcast for map-reduce.
//
// Default behavior: each mapper inspects its slice in isolation;
// findings only get pooled at REDUCE time. This causes "siloed
// mapper" failures: mapper A discovers a critical issue in
// authentication code; mapper B is independently auditing the same
// pattern in DIFFERENT files but never sees A's framing — so B
// might miss the same thing or duplicate the analysis from a
// different angle.
//
// This lever pools HIGH-CONFIDENCE findings from completed
// mappers and surfaces them in the prompt of mappers that haven't
// yet started THIS round. Tradeoff: information leak biases later
// mappers; mitigated by:
//   - only HIGH-CONFIDENCE findings cross over (threshold ≥ 7)
//   - mid-cycle context is clearly separated from the slice prompt
//     ("cross-mapper context" header)
//   - cap on number of broadcast findings per mapper to keep
//     prompts bounded
//
// Pure helpers: extraction + ranking + prompt-block builder.

export interface MapperFinding {
  /** Mapper index that surfaced the finding. */
  fromMapperIndex: number;
  /** One-sentence description of the finding. */
  text: string;
  /** Confidence 0-10. Only ≥ HIGH_CONFIDENCE_THRESHOLD findings broadcast. */
  confidence: number;
  /** Optional file path the finding refers to. */
  filePath?: string;
}

/** Confidence threshold for cross-mapper broadcast. Findings below
 *  this stay siloed. Tuned to balance "useful signal" vs "noisy
 *  bias" — ≥7 means the mapper was substantially confident. */
export const HIGH_CONFIDENCE_THRESHOLD = 7;

/** Max broadcast findings per receiving mapper. Keeps prompts bounded
 *  + biases toward the strongest signals when the producer pool grew
 *  large. */
export const MAX_BROADCAST_PER_MAPPER = 5;

/** Filter findings down to those eligible for cross-mapper broadcast. Pure. */
export function selectBroadcastFindings(
  all: readonly MapperFinding[],
): MapperFinding[] {
  return all.filter((f) => f.confidence >= HIGH_CONFIDENCE_THRESHOLD);
}

/** Pick the top N findings from another mapper to surface in THIS
 *  mapper's prompt. Excludes findings emitted by THIS mapper itself
 *  (no point telling them what they already said). Sorted by
 *  confidence desc; tie-broken by lowest from-index for
 *  determinism. Pure — exported for tests. */
export function selectFindingsForMapper(args: {
  pool: readonly MapperFinding[];
  receivingMapperIndex: number;
  maxFindings?: number;
}): MapperFinding[] {
  const { pool, receivingMapperIndex, maxFindings } = args;
  const cap = maxFindings ?? MAX_BROADCAST_PER_MAPPER;
  const eligible = pool
    .filter((f) => f.fromMapperIndex !== receivingMapperIndex)
    .filter((f) => f.confidence >= HIGH_CONFIDENCE_THRESHOLD);
  // Sort by confidence desc; tie-break by lowest from-index
  eligible.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.fromMapperIndex - b.fromMapperIndex;
  });
  return eligible.slice(0, cap);
}

/** Build the "cross-mapper context" prompt block for a receiving
 *  mapper. Empty array → empty string. Pure. */
export function buildCrossMapperContextBlock(
  findings: readonly MapperFinding[],
): string {
  if (findings.length === 0) return "";
  const lines: string[] = [
    "=== Cross-mapper context (high-confidence findings from other mappers this cycle) ===",
    "Use these to AVOID duplicating their analysis + INFORM your own — but don't be biased: your slice is different.",
    "",
  ];
  for (const f of findings) {
    const fileLabel = f.filePath ? ` [${f.filePath}]` : "";
    lines.push(
      `  - From Mapper ${f.fromMapperIndex} (confidence ${f.confidence}/10)${fileLabel}: ${f.text.trim()}`,
    );
  }
  lines.push("=== End cross-mapper context ===");
  return lines.join("\n");
}
