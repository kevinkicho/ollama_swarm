// Q5 (2026-05-04): dissent preservation for synthesizer-style turns
// (council, MoA aggregator, etc.).
//
// Default synthesizer prompts collapse N drafts into ONE consolidated
// answer. This averaging tends to wash out the most contrarian
// perspective — which is often the most informative one. The lever
// flips the synthesizer prompt to emit THREE explicit sections:
//
//   1. Majority view — the consensus across drafters
//   2. Minority report — the strongest contrarian take, preserved
//      not as a footnote but as a parallel section
//   3. Open questions — what the drafts collectively couldn't answer
//
// Pure prompt builder + parser. Runners that opt in via
// cfg.preserveDissent swap their existing synthesis prompt for this
// shape and surface the three sections in their deliverable.
//
// Tradeoffs:
//   - Longer synthesis output (~1.5-2× tokens vs single consolidated).
//   - Some users want a single answer; the three-section shape is
//     extra signal noise for THOSE users.

export interface DissentPreservedSynthesis {
  majorityView: string;
  minorityReport: string;
  openQuestions: string[];
}

export function buildDissentSynthesisPrompt(args: {
  /** What the drafts were trying to answer. */
  question: string;
  /** Each agent's final draft, in agent-index order. */
  drafts: ReadonlyArray<{ agentIndex: number; text: string }>;
  /** Optional user directive for context. */
  userDirective?: string;
}): string {
  const { question, drafts, userDirective } = args;
  const draftBlocks = drafts.map(
    (d) =>
      `=== DRAFT FROM AGENT ${d.agentIndex} ===\n${d.text.trim()}\n=== END ===`,
  );
  const directiveBlock = userDirective?.trim()
    ? [`User directive: ${userDirective.trim()}`, ""]
    : [];
  return [
    "You are SYNTHESIZING across the drafts below. Your job is NOT to pick a winner — it's to produce three honest sections that preserve everything informative.",
    "",
    `Question being answered: ${question}`,
    ...directiveBlock,
    "",
    "Drafts:",
    ...draftBlocks,
    "",
    "Output STRICT JSON only — no prose, no fences:",
    "{",
    '  "majorityView": "<2-5 sentences capturing the consensus across drafters; what most/all of them agreed on>",',
    '  "minorityReport": "<the STRONGEST contrarian take, preserved verbatim from one drafter when possible. If there was no real dissent, write \\"No meaningful dissent — drafters converged.\\". DO NOT downplay it; this section exists because the most informative insight is often the one being out-voted.>",',
    '  "openQuestions": ["<concrete question the drafts collectively couldn\'t answer>", ...]',
    "}",
    "",
    "Three rules:",
    "1. Majority view ≠ majority OPINION. If 4 drafters all said X but their evidence is weak, the majority view should report the consensus AND note its evidentiary weakness.",
    "2. Minority report MUST cite the dissenting agent (e.g., \"Agent 3 argued ...\") so the reader can trace the source.",
    "3. Open questions are GOOD — drafters collectively saying \"we don't know\" is more valuable than fabricating a confident answer.",
  ].join("\n");
}

/** Lenient parser for the three-section synthesis. Returns null on
 *  parse failure; caller falls back to the single-consolidated path. */
export function parseDissentSynthesis(
  raw: string,
): DissentPreservedSynthesis | null {
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
      const majority =
        typeof parsed.majorityView === "string" ? parsed.majorityView.trim() : "";
      const minority =
        typeof parsed.minorityReport === "string"
          ? parsed.minorityReport.trim()
          : "";
      if (!majority || !minority) continue;
      const opens = Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions
            .filter((q): q is string => typeof q === "string")
            .map((q) => q.trim())
            .filter((q) => q.length > 0)
        : [];
      return {
        majorityView: majority,
        minorityReport: minority,
        openQuestions: opens,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Render the parsed synthesis as a markdown block suitable for the
 *  deliverable. Pure helper. */
export function renderDissentSynthesisMarkdown(
  s: DissentPreservedSynthesis,
): string {
  const lines: string[] = [
    "## Majority view",
    "",
    s.majorityView,
    "",
    "## Minority report",
    "",
    s.minorityReport,
  ];
  if (s.openQuestions.length > 0) {
    lines.push("");
    lines.push("## Open questions");
    lines.push("");
    for (const q of s.openQuestions) {
      lines.push(`- ${q}`);
    }
  }
  return lines.join("\n");
}
