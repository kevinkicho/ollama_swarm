// Q13 (2026-05-04): per-preset rubric grading.
//
// After a run completes, an external judge model scores the run
// output against a task-specific rubric. Surfaces "preset X scored
// 7/10 on correctness but 3/10 on completeness" so users know
// which dimension to retry.
//
// Default rubric dimensions (per-preset overridable):
//   - correctness — does the output address the directive accurately?
//   - completeness — did the output cover every part of the ask?
//   - specificity — does it cite files / paths / line numbers?
//   - actionability — could a reader execute on it without re-asking?
//   - format — does it conform to expected shape (e.g., deliverable.md)?
//
// Pure helpers:
//   - `defaultRubricForPreset` — returns the per-preset rubric items
//   - `buildRubricGradingPrompt` — judge prompt with run output + rubric
//   - `parseRubricGrade` — parser for the structured judge response
//   - `rubricToMarkdownTable` — render scores as a deliverable section
//
// Tradeoffs:
//   - +1 judge call per run (after the run completes).
//   - Judge model bias affects scores; same model used as judge AND
//     as a run-time agent will favor its own style. Use a distinct
//     judge model when possible (e.g., paid model judges open-weights).
//   - Rubric tuning is a one-time investment that compounds across
//     runs; the per-preset defaults are starting points.

import type { PresetId } from "./SwarmRunner.js";

export interface RubricItem {
  /** Stable id (e.g., "correctness"); used as the key in grades. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** What the judge should score. One sentence. */
  description: string;
}

export interface RubricGrade {
  /** Per-item scores; key = item id, value = 0..10. */
  scores: Record<string, number>;
  /** Per-item one-sentence justifications. */
  notes: Record<string, string>;
  /** Overall score = average across items, rounded to 0.1. */
  overall: number;
  /** Headline: "ship-quality" | "needs-revision" | "fundamentally-flawed". */
  verdict: "ship-quality" | "needs-revision" | "fundamentally-flawed";
}

const UNIVERSAL_RUBRIC: readonly RubricItem[] = [
  {
    id: "correctness",
    label: "Correctness",
    description: "Does the output answer the directive accurately + free of contradictions?",
  },
  {
    id: "completeness",
    label: "Completeness",
    description: "Did it cover every part of the ask (vs skipping subparts)?",
  },
  {
    id: "specificity",
    label: "Specificity",
    description: "Does it cite concrete files / paths / line numbers / code excerpts (vs abstract platitudes)?",
  },
  {
    id: "actionability",
    label: "Actionability",
    description: "Could a reader execute on it without re-asking?",
  },
  {
    id: "format",
    label: "Format",
    description: "Does the output conform to the expected shape (deliverable.md / structured envelope / etc.)?",
  },
];

/** Per-preset rubric defaults. Most presets use the universal rubric;
 *  blackboard adds "verify-pass" (whether cfg.verifyCommand passed);
 *  debate-judge adds "evidence-density" (citations per argument).
 *  Pure. */
export function defaultRubricForPreset(preset: PresetId): readonly RubricItem[] {
  switch (preset) {
    case "blackboard":
      return [
        ...UNIVERSAL_RUBRIC,
        {
          id: "verify-pass",
          label: "Verify gate",
          description: "Did cfg.verifyCommand exit 0 against the final state? 10 = pass; 0 = fail; 5 = no verify configured.",
        },
      ];
    case "debate-judge":
      return [
        ...UNIVERSAL_RUBRIC,
        {
          id: "evidence-density",
          label: "Evidence density",
          description: "Average citations (file path / commit SHA / measurement) per argument across PRO + CON turns.",
        },
      ];
    default:
      return UNIVERSAL_RUBRIC;
  }
}

/** Build the rubric grading prompt for the judge. The runner passes
 *  the run's deliverable (or transcript summary) + the rubric. */
export function buildRubricGradingPrompt(args: {
  /** What the user asked the swarm to do. */
  directive: string;
  /** The run's primary output: deliverable.md content, or final
   *  synthesis text, or the run summary's "answer" section. */
  runOutput: string;
  /** Preset that produced the output. Used by the judge for context. */
  preset: PresetId;
  /** Per-preset rubric. Caller passes the result of defaultRubricForPreset. */
  rubric: readonly RubricItem[];
}): string {
  const { directive, runOutput, preset, rubric } = args;
  return [
    "You are GRADING a multi-agent swarm run against a task-specific rubric.",
    "Score each dimension 0-10. Be honest — the user is reading this to decide whether to retry / pick a different preset / accept as-is.",
    "",
    `Preset that produced the output: ${preset}`,
    `User directive: ${directive.trim()}`,
    "",
    "=== RUN OUTPUT ===",
    runOutput.trim().slice(0, 6000),
    "=== END RUN OUTPUT ===",
    "",
    "Rubric items:",
    ...rubric.map(
      (r) => `  - ${r.id} (${r.label}): ${r.description}`,
    ),
    "",
    "Output STRICT JSON only — no prose, no fences:",
    "{",
    `  "scores": { ${rubric.map((r) => `"${r.id}": <0-10>`).join(", ")} },`,
    `  "notes": { ${rubric.map((r) => `"${r.id}": "<one sentence>"`).join(", ")} },`,
    '  "verdict": "ship-quality" | "needs-revision" | "fundamentally-flawed"',
    "}",
    "",
    "Verdict heuristic (apply consistently):",
    "- ship-quality: every item ≥7 AND overall avg ≥8",
    "- needs-revision: at least one item between 4 and 6, OR overall 5-7",
    "- fundamentally-flawed: any item ≤3, OR overall <5",
  ].join("\n");
}

/** Lenient parser for the rubric judge response. Returns null on
 *  parse failure or missing required fields; caller falls back to
 *  not surfacing a rubric grade. */
export function parseRubricGrade(
  raw: string,
  rubric: readonly RubricItem[],
): RubricGrade | null {
  const text = raw.trim();
  if (!text) return null;
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(text);
  if (fence) candidates.push(fence[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const verdict = parsed.verdict;
      if (
        verdict !== "ship-quality" &&
        verdict !== "needs-revision" &&
        verdict !== "fundamentally-flawed"
      ) {
        continue;
      }
      const rawScores = parsed.scores;
      const rawNotes = parsed.notes;
      if (!rawScores || typeof rawScores !== "object") continue;
      if (!rawNotes || typeof rawNotes !== "object") continue;
      const scoresObj = rawScores as Record<string, unknown>;
      const notesObj = rawNotes as Record<string, unknown>;
      const scores: Record<string, number> = {};
      const notes: Record<string, string> = {};
      let total = 0;
      let count = 0;
      for (const item of rubric) {
        const s = scoresObj[item.id];
        if (typeof s !== "number" || !Number.isFinite(s)) continue;
        const clamped = Math.max(0, Math.min(10, s));
        scores[item.id] = clamped;
        total += clamped;
        count += 1;
        const n = notesObj[item.id];
        notes[item.id] = typeof n === "string" ? n.trim() : "";
      }
      if (count === 0) continue;
      const overall = Math.round((total / count) * 10) / 10;
      return { scores, notes, overall, verdict };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Render the grade as a markdown table suitable for the
 *  deliverable's "Run quality" section. Pure. */
export function rubricToMarkdownTable(args: {
  grade: RubricGrade;
  rubric: readonly RubricItem[];
}): string {
  const { grade, rubric } = args;
  const lines: string[] = [
    `**Verdict:** ${grade.verdict.toUpperCase()} · **Overall:** ${grade.overall.toFixed(1)}/10`,
    "",
    "| Dimension | Score | Note |",
    "| --- | ---: | --- |",
  ];
  for (const item of rubric) {
    const score = grade.scores[item.id];
    if (typeof score !== "number") continue;
    const note = grade.notes[item.id] ?? "";
    lines.push(`| ${item.label} | ${score}/10 | ${note.replace(/\n/g, " ")} |`);
  }
  return lines.join("\n");
}
