// 2026-05-02 (blackboard feature #5): coverage-gap detection.
//
// At end-of-run, compare what the directive + contract criteria asked
// for against what the workers actually committed. Surface "we forgot
// the most important file" failure mode.
//
// Two signals combined:
//   1. Contract-criteria expectedFiles — the planner declared these
//      files as needing changes; if any never got touched, flag.
//   2. Directive-mentioned files — extract path-shaped tokens (with
//      a slash or dot, len ≥ 4) from the user's directive; if any
//      exist in the repo but no commit touched them, flag.
//
// Output: ranked list of {file, why-flagged, severity}. Pure function
// over inputs; no I/O. Tested in isolation.

export interface CoverageGapInput {
  /** User's original directive — extracted for path-shaped mentions. */
  directive: string;
  /** Contract criteria with their expectedFiles. Pull from this.contract. */
  criteriaExpectedFiles: ReadonlyArray<{
    /** Criterion ID for the why-flagged annotation. */
    criterionId: string;
    /** Per-criterion expected files from the planner's contract. */
    expectedFiles: readonly string[];
    /** Verdict (verified/partial/false/unverifiable/unmet) for context. */
    verdict?: string;
  }>;
  /** Files the workers actually committed against — git diff --name-only
   *  output, or this.touchedFiles tracker. Repo-relative paths. */
  touchedFiles: readonly string[];
  /** Full repo file list (for verifying directive-mentioned paths exist). */
  repoFiles: readonly string[];
}

export type GapSeverity = "high" | "medium" | "low";

export interface CoverageGap {
  /** Repo-relative file path. */
  file: string;
  /** Human-readable explanation. */
  reason: string;
  /** Severity bucket — drives UI styling + ordering. */
  severity: GapSeverity;
  /** Source signal that flagged this gap. */
  source: "criterion" | "directive-mention";
  /** When source==='criterion', which criterion ID. */
  criterionId?: string;
}

/** Extract path-shaped tokens from the directive. A "path-shaped" token
 *  contains either a slash (src/foo.ts) or has a file-extension dot
 *  (foo.js, package.json) AND is ≥ 4 chars. Lowercased, deduped. */
export function extractDirectivePaths(directive: string): string[] {
  if (!directive) return [];
  // Match path-like tokens: optional dir prefix, basename with extension,
  // OR bare slash-segments. Tolerant of backticks/quotes/parentheses.
  const tokens = directive.match(/[\w./-]+\.[a-z]{1,8}\b|[\w-]+\/[\w./-]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const cleaned = t.toLowerCase().replace(/^[./]+/, "").replace(/[./]+$/, "");
    if (cleaned.length < 4) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** Detect coverage gaps. Pure — exported for tests. */
export function detectCoverageGaps(input: CoverageGapInput): CoverageGap[] {
  const touchedSet = new Set(input.touchedFiles.map((f) => f.toLowerCase()));
  const repoSet = new Set(input.repoFiles.map((f) => f.toLowerCase()));
  const gaps: CoverageGap[] = [];
  const seen = new Set<string>();

  // Signal 1: criterion-expected files that never got touched.
  for (const c of input.criteriaExpectedFiles) {
    for (const f of c.expectedFiles) {
      const lower = f.toLowerCase();
      if (touchedSet.has(lower)) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      // Severity: HIGH when the criterion verdict was "false" or "unmet"
      // (the criterion explicitly didn't meet AND the file wasn't touched —
      // strong gap signal). MEDIUM otherwise.
      const isHard = c.verdict === "false" || c.verdict === "unmet" || !c.verdict;
      gaps.push({
        file: f,
        reason: `Contract criterion ${c.criterionId} declared this file as needing changes${c.verdict ? ` (verdict: ${c.verdict})` : ""}, but no commit touched it.`,
        severity: isHard ? "high" : "medium",
        source: "criterion",
        criterionId: c.criterionId,
      });
    }
  }

  // Signal 2: directive-mentioned files that exist but weren't touched.
  // Lower confidence than criterion signal — directive mentions are often
  // illustrative rather than load-bearing. MEDIUM severity, never HIGH.
  const directiveTokens = extractDirectivePaths(input.directive);
  for (const token of directiveTokens) {
    // Only consider mentions that match an actual repo file (avoids
    // noise from things like "package.json shape" vs the actual file).
    let matchedFile: string | undefined;
    for (const f of input.repoFiles) {
      if (f.toLowerCase() === token || f.toLowerCase().endsWith("/" + token)) {
        matchedFile = f;
        break;
      }
    }
    if (!matchedFile) continue;
    if (touchedSet.has(matchedFile.toLowerCase())) continue;
    if (seen.has(matchedFile.toLowerCase())) continue;
    seen.add(matchedFile.toLowerCase());
    gaps.push({
      file: matchedFile,
      reason: `Directive mentioned this file by name, but no commit touched it.`,
      severity: "medium",
      source: "directive-mention",
    });
  }
  void repoSet; // (Signal 2 already uses input.repoFiles directly via .find.)

  // Sort: high → medium → low; within each, alphabetical by file.
  const sevOrder: Record<GapSeverity, number> = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => {
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    return s !== 0 ? s : a.file.localeCompare(b.file);
  });
  return gaps;
}

/** Format gaps as a Markdown section for the deliverable. Pure. */
export function formatCoverageGapsMarkdown(gaps: readonly CoverageGap[]): string {
  if (gaps.length === 0) {
    return "_(no coverage gaps detected — every file the directive + criteria asked for got committed)_";
  }
  const buckets: Record<GapSeverity, CoverageGap[]> = { high: [], medium: [], low: [] };
  for (const g of gaps) buckets[g.severity].push(g);
  const lines: string[] = [];
  for (const sev of ["high", "medium", "low"] as const) {
    if (buckets[sev].length === 0) continue;
    lines.push(`**${sev.toUpperCase()} severity:**`);
    for (const g of buckets[sev]) {
      lines.push(`- \`${g.file}\` — ${g.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
