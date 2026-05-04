// Q4 (2026-05-04): best-of-N at the turn level.
//
// Generalizes T199's self-consistency-on-hunks pattern to ANY agent
// turn. Instead of asking the agent once, the runner asks K times in
// parallel + a judge picks the best.
//
// Two pure helpers ship here:
//   - `pickBestSampleByLength` — heuristic fallback when no judge is
//     available; picks the longest non-empty sample (longer ≈ more
//     considered, weak-but-honest signal).
//   - `buildBestOfNJudgePrompt` + `parseBestOfNJudgePick` — when a
//     judge agent IS available, fire one judge call to pick the
//     best sample by index.
//
// The actual K-parallel firing is the runner's responsibility (it
// owns the prompt + agent). This module is the glue.
//
// Tradeoffs:
//   - K× cost (every turn costs K prompts).
//   - When judge picks, +1 judge prompt on top of K samples.
//   - Best applied to high-stakes turns (planner contracts, hunk
//     emission, judge verdicts), not every drafter chat turn.

export interface BestOfNSample {
  /** Stable id, e.g. `sample-1`. */
  id: string;
  /** The agent's output text. Empty samples should be excluded by
   *  the caller before passing to the picker. */
  text: string;
}

export interface BestOfNPick {
  /** The picked sample's id. */
  pickedId: string;
  /** Free-text rationale (empty when the heuristic fallback was used). */
  rationale: string;
}

/** Heuristic fallback picker: longest non-empty sample wins.
 *  Tie-broken by lowest id (deterministic). Pure. */
export function pickBestSampleByLength(
  samples: readonly BestOfNSample[],
): BestOfNPick | null {
  const nonEmpty = samples.filter((s) => s.text.trim().length > 0);
  if (nonEmpty.length === 0) return null;
  let best = nonEmpty[0];
  for (let i = 1; i < nonEmpty.length; i++) {
    const s = nonEmpty[i];
    if (s.text.length > best.text.length) {
      best = s;
    } else if (s.text.length === best.text.length && s.id < best.id) {
      best = s;
    }
  }
  return { pickedId: best.id, rationale: "" };
}

/** Build the judge prompt that picks among K samples by index.
 *  taskBrief tells the judge what the samples were trying to do
 *  so it can score them in context. */
export function buildBestOfNJudgePrompt(args: {
  taskBrief: string;
  samples: readonly BestOfNSample[];
  /** Optional rubric items the judge should weigh. */
  rubric?: readonly string[];
}): string {
  const { taskBrief, samples, rubric } = args;
  const rubricLines =
    rubric && rubric.length > 0
      ? [
          "",
          "Rubric (judge against these criteria):",
          ...rubric.map((r, i) => `  ${i + 1}. ${r}`),
        ]
      : [];
  return [
    "You are picking the BEST among K candidate responses to the same prompt.",
    "Score on: correctness, specificity, evidence-grounded reasoning, and format compliance.",
    `What the samples were trying to do: ${taskBrief}`,
    ...rubricLines,
    "",
    `Candidates (${samples.length}):`,
    ...samples.map(
      (s, i) =>
        `=== [${i}] id=${s.id} ===\n${s.text.trim()}\n=== END [${i}] ===`,
    ),
    "",
    "Output STRICT JSON only — no prose, no fences:",
    `{"pickedIndex": <0..${samples.length - 1}>, "rationale": "<one sentence why>"}`,
  ].join("\n");
}

/** Parse the judge response. Returns the picked sample id, or null
 *  on parse failure (caller falls back to heuristic). Pure. */
export function parseBestOfNJudgePick(
  raw: string,
  samples: readonly BestOfNSample[],
): BestOfNPick | null {
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
      const idx = parsed.pickedIndex;
      if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
      if (idx < 0 || idx >= samples.length) continue;
      const rationale =
        typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
      return { pickedId: samples[idx].id, rationale };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** End-to-end picker: try judge first if a judgePicker is supplied,
 *  fall back to length heuristic on null. The runner supplies
 *  judgePicker as `(prompt) => Promise<string>` that fires one
 *  judge prompt + returns the raw response. */
export async function pickBestOfNSample(args: {
  samples: readonly BestOfNSample[];
  taskBrief: string;
  rubric?: readonly string[];
  /** When supplied, fires a judge prompt + parses the verdict. When
   *  absent, jumps straight to the length heuristic. */
  judgePicker?: (prompt: string) => Promise<string>;
}): Promise<BestOfNPick | null> {
  const { samples, taskBrief, rubric, judgePicker } = args;
  if (samples.length === 0) return null;
  if (samples.length === 1) {
    const only = samples[0];
    if (only.text.trim().length === 0) return null;
    return { pickedId: only.id, rationale: "" };
  }
  if (judgePicker) {
    const prompt = buildBestOfNJudgePrompt({ taskBrief, samples, rubric });
    try {
      const raw = await judgePicker(prompt);
      const parsed = parseBestOfNJudgePick(raw, samples);
      if (parsed) return parsed;
    } catch {
      // judge call failed — fall through to heuristic
    }
  }
  return pickBestSampleByLength(samples);
}
