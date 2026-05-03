// 2026-05-02 (blackboard feature #2): PR-shaped output composer.
//
// Builds a maintainer-ready PR description from blackboard's run state.
// The user can paste the result directly into a GitHub PR or issue.
// All inputs already exist in summary.json + the contract; this is
// pure formatting.
//
// Sections:
//   Title — short, derived from the directive (≤ 70 chars)
//   Summary — 1-2 sentence description of what changed and why
//   Changes — per-commit table with SHA prefix + message + files touched
//   Verification — verify gate status + auditor verdict per criterion
//   Unmet criteria — explicit list of criteria the auditor flagged
//   Open questions — stretch goals + auditor's "unverifiable" entries

export interface PRCommitEntry {
  shaPrefix: string;
  message: string;
  filesChanged: number;
  /** Optional list of file paths if available (truncated to 5). */
  files?: readonly string[];
}

export interface PRCriterionEntry {
  id: string;
  description: string;
  verdict: "verified" | "partial" | "false" | "unverifiable" | "unmet";
  rationale?: string;
}

export interface PRDescriptionInput {
  /** Original user directive — drives Title + Summary. */
  directive: string;
  /** Per-commit entries from `git log` (oldest-first). */
  commits: readonly PRCommitEntry[];
  /** Whether the verify gate passed (true), failed (false), or wasn't
   *  configured (null). */
  verifyPassed: boolean | null;
  /** Per-criterion auditor results from this.contract.criteria. */
  criteria: readonly PRCriterionEntry[];
  /** Stretch-goal reflection items (Task #129) — surfaced as Open
   *  Questions. Empty when no reflection ran. */
  stretchGoals?: readonly string[];
}

/** Build a one-line title from the directive. Caps at 70 chars; trims
 *  trailing punctuation. Pure.
 *
 *  Order matters: strip punctuation FIRST, then truncate. Reversing
 *  the order would strip the trailing "..." of an ellipsis-truncated
 *  long title (because "." is in the strip set). */
export function buildPRTitle(directive: string): string {
  const trimmed = directive.trim();
  if (trimmed.length === 0) return "Swarm-generated changes";
  // Take first sentence — split on punctuation (including bare ?/!
  // even when not followed by space, so questions land cleanly).
  const firstSentence = trimmed.split(/[.!?](?:\s+|$)/)[0];
  const stripped = firstSentence.replace(/[.,;:!?]+$/, "");
  if (stripped.length <= 70) return stripped;
  return stripped.slice(0, 67) + "...";
}

/** Build the Summary section. Pure. */
export function buildPRSummary(directive: string, commits: readonly PRCommitEntry[]): string {
  const directiveTrimmed = directive.trim();
  const commitWord = commits.length === 1 ? "commit" : "commits";
  if (directiveTrimmed.length === 0) {
    return `${commits.length} ${commitWord} from a swarm run.`;
  }
  return `Implements: "${directiveTrimmed}"\n\nDelivered as ${commits.length} ${commitWord}.`;
}

/** Render commit-table section. Pure. */
function renderCommitsSection(commits: readonly PRCommitEntry[]): string {
  if (commits.length === 0) return "_(no commits landed)_";
  const lines: string[] = ["| SHA | Message | Files |", "| --- | --- | ---: |"];
  for (const c of commits) {
    // Markdown table cells must escape pipes inside content
    const safeMessage = c.message.replace(/\|/g, "\\|").slice(0, 120);
    lines.push(`| \`${c.shaPrefix}\` | ${safeMessage} | ${c.filesChanged} |`);
  }
  return lines.join("\n");
}

/** Render the verification section. Pure. */
function renderVerificationSection(input: PRDescriptionInput): string {
  const lines: string[] = [];
  if (input.verifyPassed === true) {
    lines.push("✅ **Verify gate**: PASSED (configured `verifyCommand` exited 0).");
  } else if (input.verifyPassed === false) {
    lines.push("❌ **Verify gate**: FAILED — review carefully before merging.");
  } else {
    lines.push("⚪ **Verify gate**: not configured — no automated test/lint signal on this run.");
  }
  if (input.criteria.length > 0) {
    lines.push("");
    lines.push("**Auditor per-criterion verdict:**");
    lines.push("");
    lines.push("| ID | Verdict | Description |");
    lines.push("| --- | --- | --- |");
    for (const c of input.criteria) {
      const icon =
        c.verdict === "verified" ? "✅" :
        c.verdict === "partial" ? "🟡" :
        c.verdict === "false" ? "❌" :
        c.verdict === "unmet" ? "⬜" :
        "❓"; // unverifiable
      const desc = c.description.replace(/\|/g, "\\|").slice(0, 120);
      lines.push(`| ${c.id} | ${icon} ${c.verdict} | ${desc} |`);
    }
  }
  return lines.join("\n");
}

/** Render Unmet Criteria + Open Questions section. Pure. */
function renderOpenSection(input: PRDescriptionInput): string {
  const unmet = input.criteria.filter(
    (c) => c.verdict === "false" || c.verdict === "unmet" || c.verdict === "partial",
  );
  const unverifiable = input.criteria.filter((c) => c.verdict === "unverifiable");
  const lines: string[] = [];
  if (unmet.length > 0) {
    lines.push("**Unmet criteria** (review or follow-up):");
    for (const c of unmet) {
      lines.push(`- \`${c.id}\` (${c.verdict}): ${c.description}${c.rationale ? ` — _${c.rationale}_` : ""}`);
    }
    lines.push("");
  }
  if (unverifiable.length > 0) {
    lines.push("**Unverifiable criteria** (couldn't confirm — needs human review):");
    for (const c of unverifiable) {
      lines.push(`- \`${c.id}\`: ${c.description}${c.rationale ? ` — _${c.rationale}_` : ""}`);
    }
    lines.push("");
  }
  if (input.stretchGoals && input.stretchGoals.length > 0) {
    lines.push("**Stretch goals** (out of scope for this run; consider for follow-up):");
    for (const g of input.stretchGoals) {
      lines.push(`- ${g}`);
    }
    lines.push("");
  }
  if (lines.length === 0) {
    return "_(no unmet criteria, no open questions — the run met its full contract)_";
  }
  return lines.join("\n").trim();
}

/** Compose the full PR description as Markdown. Pure — exported for
 *  tests. */
export function buildPRDescription(input: PRDescriptionInput): string {
  const title = buildPRTitle(input.directive);
  const summary = buildPRSummary(input.directive, input.commits);
  const sections: string[] = [
    `# ${title}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Changes",
    "",
    renderCommitsSection(input.commits),
    "",
    "## Verification",
    "",
    renderVerificationSection(input),
    "",
    "## Open",
    "",
    renderOpenSection(input),
  ];
  return sections.join("\n");
}
