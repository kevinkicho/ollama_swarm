// 2026-05-02 (stigmergy improvement #3): top-down directive check.
//
// Stigmergy's report-out is bottom-up: lead reads the annotation table
// + narrates what was found. Adding a top-down pass — "given the
// directive, what areas SHOULD have been explored that don't appear
// in the annotations?" — closes the "we missed the most important
// thing" failure mode.
//
// Mirrors the coverageGap.ts shipped for blackboard but focused on
// exploration-side: for stigmergy the question isn't "what did we
// commit to?" but "what did we walk past?".

export type ExplorationGapSeverity = "high" | "medium" | "low";

export interface ExplorationGap {
  /** Repo-relative path or directory the swarm should have visited. */
  target: string;
  /** Why this matters — derived from the signal that flagged it. */
  reason: string;
  /** Severity bucket — drives ordering + UI styling. */
  severity: ExplorationGapSeverity;
  /** Source signal. */
  source: "directive-mention" | "top-level-dir";
}

export interface ExplorationGapInput {
  /** User's original directive — extracted for path-shaped mentions. */
  directive: string;
  /** Files/dirs the explorers actually annotated. */
  annotatedFiles: readonly string[];
  /** Full repo file list for verifying mentioned paths exist + for
   *  detecting top-level dirs that got zero exploration. */
  repoFiles: readonly string[];
}

/** Pure regex extractor for path-shaped tokens in the directive.
 *  Handles bare paths (src/auth.ts), top-level dirs (src/), and file
 *  basenames with extensions. Lowercased + deduped. Pure. */
export function extractDirectiveExplorationTargets(directive: string): string[] {
  if (!directive) return [];
  const tokens = directive.match(/[\w./-]+\.[a-z]{1,8}\b|[\w-]+\/[\w./-]+|[\w-]+\//gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const cleaned = t.toLowerCase().replace(/^[./]+/, "");
    if (cleaned.length < 4) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** Detect top-level directories present in the repo. Stigmergy's
 *  exploration is supposed to cover the breadth of the codebase;
 *  zero-coverage top-level dirs are a real signal of incomplete
 *  exploration. Pure. */
export function extractTopLevelDirs(repoFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const f of repoFiles) {
    const slashIdx = f.indexOf("/");
    if (slashIdx <= 0) continue; // root-level file, no dir
    const top = f.slice(0, slashIdx).toLowerCase();
    seen.add(top);
  }
  return [...seen];
}

/** Detect exploration gaps. Pure — exported for tests. */
export function detectExplorationGaps(input: ExplorationGapInput): ExplorationGap[] {
  const annotatedSet = new Set(input.annotatedFiles.map((f) => f.toLowerCase()));
  const annotatedTopDirs = new Set<string>();
  for (const f of input.annotatedFiles) {
    const slash = f.indexOf("/");
    if (slash > 0) annotatedTopDirs.add(f.slice(0, slash).toLowerCase());
  }
  const gaps: ExplorationGap[] = [];
  const seen = new Set<string>();

  // Signal 1: directive-mentioned files/dirs that exist in the repo
  // but no explorer touched. HIGH severity — the user explicitly named
  // these.
  const directiveTargets = extractDirectiveExplorationTargets(input.directive);
  for (const target of directiveTargets) {
    let matched: string | undefined;
    for (const f of input.repoFiles) {
      const lower = f.toLowerCase();
      if (lower === target || lower.endsWith("/" + target) || lower.startsWith(target)) {
        matched = f;
        break;
      }
    }
    if (!matched) continue;
    if (annotatedSet.has(matched.toLowerCase())) continue;
    // For dir mentions, count as covered if ANY file under that dir got annotated.
    if (target.endsWith("/")) {
      const dirPrefix = target.toLowerCase();
      const someAnnotated = [...annotatedSet].some((f) => f.startsWith(dirPrefix));
      if (someAnnotated) continue;
    }
    if (seen.has(matched.toLowerCase())) continue;
    seen.add(matched.toLowerCase());
    gaps.push({
      target: matched,
      reason: `Directive mentioned this target by name, but no explorer annotated it.`,
      severity: "high",
      source: "directive-mention",
    });
  }

  // Signal 2: top-level dirs in the repo with ZERO annotated files
  // under them. MEDIUM severity — these aren't directive-named but are
  // "you should have at least walked this branch" gaps.
  const topDirs = extractTopLevelDirs(input.repoFiles);
  // Skip noise dirs that explorers correctly avoid
  const SKIP_TOP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", "coverage"]);
  for (const dir of topDirs) {
    if (SKIP_TOP_DIRS.has(dir)) continue;
    if (annotatedTopDirs.has(dir)) continue;
    if (seen.has(dir + "/")) continue;
    seen.add(dir + "/");
    gaps.push({
      target: dir + "/",
      reason: `Top-level directory present in the repo but ZERO files under it were annotated by any explorer.`,
      severity: "medium",
      source: "top-level-dir",
    });
  }

  // Sort: high → medium → low; within each, alphabetical.
  const sevOrder: Record<ExplorationGapSeverity, number> = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => {
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    return s !== 0 ? s : a.target.localeCompare(b.target);
  });
  return gaps;
}

/** Format gaps as a Markdown section for the deliverable. Pure. */
export function formatExplorationGapsMarkdown(gaps: readonly ExplorationGap[]): string {
  if (gaps.length === 0) {
    return "_(no exploration gaps detected — every directive-named target + top-level dir was visited)_";
  }
  const buckets: Record<ExplorationGapSeverity, ExplorationGap[]> = { high: [], medium: [], low: [] };
  for (const g of gaps) buckets[g.severity].push(g);
  const lines: string[] = [];
  for (const sev of ["high", "medium", "low"] as const) {
    if (buckets[sev].length === 0) continue;
    lines.push(`**${sev.toUpperCase()} severity:**`);
    for (const g of buckets[sev]) {
      lines.push(`- \`${g.target}\` — ${g.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
