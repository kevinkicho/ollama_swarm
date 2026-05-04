// Q1 (2026-05-04): self-critique pass. Universal opt-in lever
// available to any runner via cfg.selfCritique. After an agent
// produces its turn output, the SAME agent is given the output back
// + a critique prompt + asked to (a) flag hedging/contradictions/
// gaps and (b) emit a refined version when warranted.
//
// Tradeoffs:
//   - 2× per-turn latency (one critique call per turn)
//   - Self-critique is weaker than peer-critique (model has biases
//     toward its own output). Future: add a peer-critique variant
//     that routes to a DIFFERENT agent.
//   - Best applied to high-stakes turns (planner contracts, judge
//     verdicts, synthesis passes); cheap fan-out on every drafter
//     turn isn't worth the cost.

/** Pure helper that builds the self-critique prompt. The agent
 *  receives its own prior output + a checklist; emits a structured
 *  verdict and (when warranted) a refined response. */
export function buildSelfCritiquePrompt(args: {
  /** Original output the agent just produced. */
  originalOutput: string;
  /** What the agent was trying to do (one sentence). Lets the
   *  critique check "did the output actually answer the ask?" */
  taskBrief: string;
  /** Optional task-specific checklist items. When supplied, the
   *  critique focuses on these as well as the general checklist. */
  customChecks?: readonly string[];
}): string {
  const { originalOutput, taskBrief, customChecks } = args;
  const customLines =
    customChecks && customChecks.length > 0
      ? [
          "",
          "Task-specific checks:",
          ...customChecks.map((c, i) => `  ${i + 1}. ${c}`),
        ]
      : [];
  return [
    "You are reviewing your OWN prior response. Be ruthless: a self-",
    "critique pass exists because models hedge, contradict themselves,",
    "and skip parts of the ask. Find the specific failure modes below.",
    "",
    `What you were trying to do: ${taskBrief}`,
    "",
    "=== YOUR PRIOR RESPONSE ===",
    originalOutput.trim(),
    "=== END PRIOR RESPONSE ===",
    "",
    "Critique checklist:",
    "  1. Hedging — did you use 'might', 'could', 'possibly' where you should commit? List specific phrases.",
    "  2. Contradictions — does any sentence contradict another? Cite both.",
    "  3. Skipped asks — does the response answer EVERY part of the brief? List anything dropped.",
    "  4. Unsupported claims — did you assert facts you don't have evidence for? Cite each.",
    "  5. Format compliance — if the brief specified a format, does the response match? List deviations.",
    ...customLines,
    "",
    "Output STRICT JSON only — no prose, no fences:",
    "{",
    '  "verdict": "ship-as-is" | "minor-revisions" | "major-revisions",',
    '  "issues": [{"category": "hedging" | "contradictions" | "skipped" | "unsupported" | "format" | "other", "detail": "<one sentence>"}],',
    '  "refined": "<the IMPROVED response when verdict !== ship-as-is; otherwise empty string>"',
    "}",
    "",
    "When verdict === 'ship-as-is', `issues` may be empty + `refined` MUST be empty.",
    "When verdict !== 'ship-as-is', `refined` MUST contain the improved response and is what gets used downstream.",
  ].join("\n");
}

/** Parsed verdict from the self-critique pass. */
export interface SelfCritiqueVerdict {
  verdict: "ship-as-is" | "minor-revisions" | "major-revisions";
  issues: Array<{
    category:
      | "hedging"
      | "contradictions"
      | "skipped"
      | "unsupported"
      | "format"
      | "other";
    detail: string;
  }>;
  /** Refined response when verdict !== ship-as-is; empty otherwise. */
  refined: string;
}

/** Lenient parser. Three-strategy JSON parse (strict, fenced, brace-
 *  scan) matching the project pattern. Returns null on any failure;
 *  caller falls back to the original output. Pure — exported for tests. */
export function parseSelfCritiqueResponse(
  raw: string,
): SelfCritiqueVerdict | null {
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
        verdict !== "ship-as-is" &&
        verdict !== "minor-revisions" &&
        verdict !== "major-revisions"
      ) {
        continue;
      }
      const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : [];
      const issues: SelfCritiqueVerdict["issues"] = [];
      for (const i of issuesRaw) {
        if (!i || typeof i !== "object") continue;
        const o = i as Record<string, unknown>;
        const cat = o.category;
        if (
          cat !== "hedging" &&
          cat !== "contradictions" &&
          cat !== "skipped" &&
          cat !== "unsupported" &&
          cat !== "format" &&
          cat !== "other"
        ) {
          continue;
        }
        const detail = typeof o.detail === "string" ? o.detail.trim() : "";
        if (detail.length === 0) continue;
        issues.push({ category: cat, detail });
      }
      const refined = typeof parsed.refined === "string" ? parsed.refined : "";
      return { verdict, issues, refined };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Decide whether to ship the original output or the refined one.
 *  Returns the refined output when verdict warrants it AND refined
 *  is non-empty; original otherwise. Pure helper. */
export function pickPostCritiqueOutput(args: {
  original: string;
  verdict: SelfCritiqueVerdict | null;
}): { output: string; replaced: boolean } {
  if (!args.verdict) return { output: args.original, replaced: false };
  if (args.verdict.verdict === "ship-as-is") {
    return { output: args.original, replaced: false };
  }
  const refined = args.verdict.refined.trim();
  if (refined.length === 0) return { output: args.original, replaced: false };
  return { output: refined, replaced: true };
}
