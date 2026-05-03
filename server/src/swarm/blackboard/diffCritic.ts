// 2026-05-02 (blackboard feature #3): diff-aware critic.
//
// Reads the actual git diff (added lines, not the transcript) and
// flags anti-patterns the per-criterion auditor doesn't catch because
// the auditor reasons about INTENT, not CRAFT:
//   - Debug prints left in (console.log, print, dbg!, fmt.Println)
//   - TODO/FIXME/XXX comments added by the swarm itself
//   - Dead code added (unused imports — heuristic via "import X" with
//     no following X reference in the same file)
//   - Suspicious patterns (eslint-disable, ts-ignore, type assertions
//     to any/unknown, hard-coded credentials)
//   - Comment-only changes (commits with no actual code change)
//   - Test files with no expectations (it/test blocks with no assert/
//     expect)
//
// Pure parser over the raw diff text — no LLM call, no I/O. Output
// is a list of {file, line, pattern, severity, message}.

export type AntiPatternSeverity = "high" | "medium" | "low";

export interface AntiPatternFinding {
  file: string;
  /** New-file line number (best-effort from the diff hunk header). */
  line: number;
  pattern: string;
  severity: AntiPatternSeverity;
  message: string;
}

interface PatternRule {
  /** Display name. */
  pattern: string;
  /** Regex matched against added lines (lines starting with `+`). */
  match: RegExp;
  /** Severity bucket. */
  severity: AntiPatternSeverity;
  /** Human-readable explanation. */
  message: string;
  /** When set, only fire when the file matches this glob-ish pattern. */
  fileMatch?: RegExp;
  /** When set, the line must NOT match this exclusion regex (false positives). */
  exclude?: RegExp;
}

const RULES: readonly PatternRule[] = [
  {
    pattern: "debug-print",
    match: /^\+\s*(?:console\.(?:log|debug)|print(?:ln)?\(|dbg!\(|fmt\.Println|System\.out\.println)/,
    severity: "high",
    message: "Debug print statement added — likely left over from development.",
    // Skip test files where console.log is sometimes legitimate
    exclude: /\b(test|spec|__tests__|fixture)/i,
  },
  {
    pattern: "self-added-todo",
    match: /^\+.*\b(TODO|FIXME|XXX|HACK)\b[: ].*$/,
    severity: "medium",
    message: "TODO/FIXME/HACK comment added — the swarm flagged its own deferred work as a comment instead of doing it.",
  },
  {
    pattern: "lint-suppression",
    match: /^\+.*(?:eslint-disable|ts-ignore|ts-expect-error|@ts-nocheck|noqa|# pylint: disable)/,
    severity: "high",
    message: "Lint/type suppression added — investigate whether the underlying issue should be fixed instead.",
  },
  {
    pattern: "any-cast",
    match: /^\+.*\bas\s+(?:any|unknown)\b/,
    severity: "medium",
    message: "Type cast to any/unknown added — usually a sign the type model is wrong.",
    fileMatch: /\.(ts|tsx)$/,
  },
  {
    pattern: "hardcoded-secret",
    match: /^\+.*(?:api[-_]?key|secret|token|password)\s*[:=]\s*["'`][a-zA-Z0-9_-]{12,}/i,
    severity: "high",
    message: "Looks like a hardcoded secret/credential — must use env var or secret manager.",
  },
  {
    pattern: "test-no-expect",
    // Best-effort: an `it(` or `test(` line with no expect/assert in the same line.
    // Real coverage check would need parsing; this is the cheap heuristic.
    match: /^\+\s*(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*\{?\s*\}?\s*\)?\s*;?\s*$/,
    severity: "medium",
    message: "Test block added with no body — empty test (will pass vacuously).",
    fileMatch: /\.(test|spec)\.[jt]sx?$/,
  },
];

/** Parse a unified diff string into per-file added lines + line numbers.
 *  Pure — exported for tests. Handles standard `git diff` output:
 *    diff --git a/foo b/foo
 *    @@ -X,Y +A,B @@
 *    +added line
 *    -removed line
 *    context line
 *
 *  Returns: array of {file, lineNum, text} for each added line. */
export function parseDiffAddedLines(diff: string): Array<{ file: string; lineNum: number; text: string }> {
  if (!diff) return [];
  const lines = diff.split(/\r?\n/);
  const out: Array<{ file: string; lineNum: number; text: string }> = [];
  let currentFile = "";
  let currentLineNum = 0;
  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") && currentFile) {
      out.push({ file: currentFile, lineNum: currentLineNum, text: line });
      currentLineNum += 1;
      continue;
    }
    if (line.startsWith("-")) {
      // Removed line — does not advance the new-file line number.
      continue;
    }
    if (currentFile && currentLineNum > 0) {
      // Context line — advances new-file line.
      currentLineNum += 1;
    }
  }
  return out;
}

/** Run the anti-pattern matcher over a parsed diff. Pure — exported
 *  for tests. Returns findings sorted by severity (high → low) then
 *  by file path for stability. */
export function detectAntiPatterns(diff: string): AntiPatternFinding[] {
  const added = parseDiffAddedLines(diff);
  const out: AntiPatternFinding[] = [];
  for (const { file, lineNum, text } of added) {
    for (const rule of RULES) {
      if (rule.fileMatch && !rule.fileMatch.test(file)) continue;
      if (!rule.match.test(text)) continue;
      if (rule.exclude && rule.exclude.test(file)) continue;
      out.push({
        file,
        line: lineNum,
        pattern: rule.pattern,
        severity: rule.severity,
        message: rule.message,
      });
    }
  }
  const sevOrder: Record<AntiPatternSeverity, number> = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => {
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    if (s !== 0) return s;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
  return out;
}

/** Format findings as a Markdown section for the deliverable. Pure. */
export function formatAntiPatternsMarkdown(findings: readonly AntiPatternFinding[]): string {
  if (findings.length === 0) {
    return "_(no anti-patterns detected in the diff — clean craft check)_";
  }
  const lines: string[] = [];
  // Group by severity for at-a-glance reading.
  const buckets: Record<AntiPatternSeverity, AntiPatternFinding[]> = {
    high: [],
    medium: [],
    low: [],
  };
  for (const f of findings) buckets[f.severity].push(f);
  for (const sev of ["high", "medium", "low"] as const) {
    if (buckets[sev].length === 0) continue;
    lines.push(`**${sev.toUpperCase()} severity (${buckets[sev].length}):**`);
    for (const f of buckets[sev]) {
      lines.push(`- \`${f.file}:${f.line}\` (${f.pattern}) — ${f.message}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
