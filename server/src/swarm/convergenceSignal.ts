// 2026-05-03 (Phase A of shared-layer refactor): unified parser for
// the `CONVERGENCE: high|medium|low` signal that synthesis prompts
// emit on their final line.
//
// Pre-extraction state (the audit's Pattern 5):
//   - parseCouncilConvergence in CouncilRunner.ts:871
//   - parseRoleDiffConvergence in RoundRobinRunner.ts:1143
//     (its comment header literally says "Mirrors parseCouncilConvergence")
//   - a third looser inline copy in RoundRobinRunner.runStructuredSynthesisPass
//     that does `text.toLowerCase().split('\n').reverse().join(' ').includes(...)`
//
// All three live now in this module: the strict parser (`parseConvergenceSignal`)
// for the canonical "trailing-3-lines" semantics + a loose parser
// (`parseConvergenceSignalLoose`) for the looser "anywhere in text" semantics.
// Old exports stay as deprecated re-exports for one cycle so external
// callers keep building.

export type ConvergenceLevel = "high" | "medium" | "low";

/** Strict parser. Scans the LAST 3 non-blank lines of `text` for a
 *  `CONVERGENCE: <level>` line (case-insensitive). Returns the matched
 *  level, or null when no match. The 3-line tail window prevents a
 *  passing mention of "convergence" mid-prose from counting as the
 *  signal — only a genuine trailing line is honored.
 *
 *  This is the canonical parser for synthesis prompts that explicitly
 *  instruct "On the FINAL line of your response output exactly one of
 *  CONVERGENCE: high|medium|low". */
export function parseConvergenceSignal(text: string): ConvergenceLevel | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-3);
  for (const line of tail) {
    const m = /^convergence\s*:\s*(high|medium|low)\b/i.exec(line);
    if (m) return m[1].toLowerCase() as ConvergenceLevel;
  }
  return null;
}

/** Loose parser. Returns the FIRST level mention found anywhere in the
 *  text in HIGH > MEDIUM > LOW priority. Replaces RoundRobin's old
 *  inline `text.toLowerCase().includes("convergence: high")` ladder.
 *
 *  When in doubt, prefer `parseConvergenceSignal` — the strict version
 *  is what every synthesis prompt is contract'd to produce. The loose
 *  parser exists for cases where the model emits the signal in
 *  unexpected places (e.g. mid-prose) and the runner wants to honor
 *  it anyway as a best-effort. */
export function parseConvergenceSignalLoose(text: string): ConvergenceLevel | null {
  const lower = text.toLowerCase();
  if (lower.includes("convergence: high")) return "high";
  if (lower.includes("convergence: medium")) return "medium";
  if (lower.includes("convergence: low")) return "low";
  return null;
}
