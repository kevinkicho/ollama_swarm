import type { Agent } from "../services/AgentManager.js";
import type { AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import { extractText } from "./extractText.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { repairAndParseJson } from "./repairJson.js";
import { describeSdkError } from "./sdkError.js";
import { readDirective, buildInlineDirectiveBlock } from "./directivePromptHelpers.js";

export const DEFAULT_PROPOSITION = "This project is ready for production use.";

interface BuildDebaterPromptArgs {
  side: "pro" | "con";
  round: number;
  totalRounds: number;
  proposition: string;
  isFinalRound: boolean;
  transcript: readonly TranscriptEntry[];
  userDirective?: string;
}

export function buildDebaterPrompt(args: BuildDebaterPromptArgs): string {
  const { side, round, totalRounds, proposition, isFinalRound, transcript, userDirective } = args;
  const role = side === "pro" ? "PRO (arguing FOR)" : "CON (arguing AGAINST)";
  const stance = side === "pro" ? "FOR" : "AGAINST";
  const agentIndex = side === "pro" ? 1 : 2;

  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  const roundBrief = isFinalRound
    ? "This is the FINAL round — make your closing statement. Summarize your strongest points, directly address your opponent's strongest points, and make clear WHY the judge should decide in your favor."
    : `This is round ${round} of ${totalRounds}. Make your strongest case this round. Rebut your opponent's prior argument specifically (quote or paraphrase a line they made) rather than talking past them.`;

  // 2026-05-03 (debate-judge improvement #2): broader directive context.
  // The proposition is what PRO/CON debate; the directive is the
  // broader work. Knowing the directive helps debaters frame arguments
  // around real consequences ("if we go the bcrypt-big-PR route,
  // <directive> will / won't be unblocked because…") rather than
  // arguing the proposition in a vacuum.
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work this debate informs",
    followUpLines: [
      "Your arguments should consider how the proposition affects the broader directive — but stay focused on debating THE PROPOSITION specifically.",
    ],
  });

  return [
    `You are Agent ${agentIndex}, the ${role} debater in a structured debate.`,
    `Proposition: "${proposition}"`,
    `Your job: argue ${stance} the proposition.`,
    ...directiveBlock,
    roundBrief,
    "",
    "Your working directory IS the project clone — you may use file-read, grep, and find-files tools to gather evidence for your position.",
    "Keep responses under ~300 words. Cite file paths (e.g. `src/foo.ts:42`) where relevant — concrete evidence beats abstract argument.",
    "Do NOT flip sides. Do NOT concede the proposition — your role is adversarial. If the evidence genuinely contradicts your side, find a narrower framing that's still defensible.",
    "",
    // T184 (2026-05-04): opposing-evidence requirement. Forces the
    // debate onto real codebase facts rather than abstract argument.
    // Each turn must include a "## Evidence" sub-block with at least
    // ONE specific citation — file path / test name / commit SHA /
    // measurement — that supports the side. Pure abstract debaters
    // get re-prompted.
    "**EVIDENCE BLOCK (required every turn):** Include a section labeled `## Evidence` with at least ONE concrete citation supporting your position this turn. Format:",
    "    ## Evidence",
    "    - <file path or test name or commit SHA>: <one-line why it supports your stance>",
    "    - (optionally more)",
    "Citations must be real (verified via tools) — fabricating evidence to seem grounded is worse than abstract argument. If after honest investigation you can't find any, write `## Evidence\\n_No specific evidence found this turn — argument rests on general principles X, Y._` and explain.",
    "",
    "=== DEBATE TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — you open the debate)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex} (${role}).`,
  ].join("\n");
}

interface BuildJudgePromptArgs {
  proposition: string;
  transcript: readonly TranscriptEntry[];
  userDirective?: string;
}

export function buildJudgePrompt(args: BuildJudgePromptArgs): string {
  const { proposition, transcript, userDirective } = args;
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  // 2026-05-03 (debate-judge improvement #2): directive context for
  // the judge. The verdict's nextAction should advance the broader
  // directive when set — not just a generic "next thing to do" given
  // the proposition. Implementer's write-tools turn will action it.
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "what the implementer's nextAction should target",
    followUpLines: [
      "When you fill in `nextAction`, frame it as the concrete next step toward the directive informed by the debate's verdict — not a generic 'consider X' suggestion.",
    ],
  });

  // Task #81 (2026-04-25): structured verdict. Previously freeform
  // text; now JSON envelope so the modal renders a scorecard.
  // Parser is lenient — falls back to freeform-as-rationale if model
  // doesn't comply with JSON shape.
  return [
    "You are Agent 3, the JUDGE of a structured debate.",
    `Proposition: "${proposition}"`,
    ...directiveBlock,
    "Your job: score the debate on the MERITS of the arguments presented, not on your prior opinion of the proposition. Score independently — a weaker argument for the 'correct' side should lose to a stronger argument for the 'wrong' side.",
    "",
    "Output ONLY a JSON object matching this shape (no prose, no fences, no commentary):",
    "{",
    '  "winner": "pro" | "con" | "tie",',
    '  "confidence": "low" | "medium" | "high",',
    '  "proStrongest": "1-2 sentences naming PRO\'s best argument",',
    '  "conStrongest": "1-2 sentences naming CON\'s best argument",',
    '  "proWeakest": "1-2 sentences naming PRO\'s weakest point",',
    '  "conWeakest": "1-2 sentences naming CON\'s weakest point",',
    '  "decisive": "1 sentence — what tipped the balance",',
    '  "nextAction": "1 sentence — concrete action a developer should take given this verdict, or \\"none needed\\""',
    "}",
    "",
    "Cite debaters as 'PRO' / 'CON' (not Agent 1 / Agent 2) inside the strings for readability.",
    "",
    "=== FULL DEBATE TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now produce the JSON verdict.",
  ].join("\n");
}

// Task #135: heuristic "did the implementer actually do anything?"
// scanner. Looks for two positive signals:
//   1. an explicit `CHANGED:` line (the format the prompt requires)
//   2. at least one src-style path with a line number (e.g. src/foo.ts:42)
// Absent BOTH, the response is almost certainly narration-only and the
// signoff will reject it. Pure observability — emits a log + system
// note so the next failure has the diagnostic upstream of the verdict.
export function scanImplementerForNoOp(text: string): {
  likelyNoOp: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const hasChangedTag = /^\s*CHANGED:\s*/im.test(text);
  // Match common path:line patterns — e.g. src/foo.ts:42, ./bar/baz.tsx:1
  // Excludes URL-like matches (http://...) by requiring a slash-separated
  // path prefix without a colon-after-scheme.
  const pathLineRegex = /(?:^|\s|`|"|\()(?:\.{1,2}\/)?[a-zA-Z_][\w./-]*\.[a-zA-Z]{1,5}:\d+/m;
  const hasPathCitation = pathLineRegex.test(text);
  if (!hasChangedTag) reasons.push("no CHANGED: tag");
  if (!hasPathCitation) reasons.push("no path:line citation");
  // Mention of explicit no-op acknowledgement is fine — the prompt
  // allows `CHANGED: (none — reason: …)` so the reviewer can decide.
  // Don't flag those as suspicious.
  const isAcknowledgedNoOp = /CHANGED:\s*\(none\b/i.test(text);
  if (isAcknowledgedNoOp) {
    return { likelyNoOp: false, reasons: [] };
  }
  return { likelyNoOp: !hasChangedTag && !hasPathCitation, reasons };
}

// Task #102: post-verdict build phase prompts. Each turn (PRO=
// implementer, CON=reviewer, JUDGE=signoff) gets a focused prompt
// that frames its job in terms of the verdict's nextAction. The
// implementer is the only turn with file-edit tools.
export function buildImplementerPrompt(
  proposition: string,
  verdict: ParsedDebateVerdict,
  userDirective?: string,
): string {
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work this next-action targets",
    followUpLines: [
      "Your file edits should be a concrete step toward the directive, informed by the debate's verdict.",
    ],
  });
  return [
    `You are now the IMPLEMENTER (formerly PRO debater). The debate concluded with the JUDGE recommending a concrete next action — your job is to action it on the codebase.`,
    `Original proposition: "${proposition}"`,
    `Verdict winner: ${verdict.winner.toUpperCase()} · confidence: ${verdict.confidence}`,
    ...directiveBlock,
    `=== NEXT ACTION TO IMPLEMENT ===`,
    verdict.nextAction,
    `=== END ===`,
    "",
    "You have file-edit tools available (write/edit/create). Use them.",
    "1. Read the relevant files first — understand the current state before changing.",
    "2. Make the smallest concrete change that meaningfully advances the next-action recommendation. Do NOT try to do everything; one focused edit is better than a sprawling one.",
    "3. After editing, write a short report (under ~250 words) describing: which files you changed, what you changed and why, and what you deliberately did NOT change so the reviewer knows your scope.",
    "",
    "Cite paths (e.g. `src/foo.ts:42`). Be specific. If the next-action is genuinely impossible to action with file edits (e.g. \"talk to legal\"), say so explicitly and explain why — do NOT pretend to act.",
    "",
    // Task #135: signoff has been observed REJECTING implementer turns
    // that contain only narration ("I will read foo.ts and add bar")
    // with no actual edits + no concrete file:line citations. Make the
    // expected report shape explicit so the model has nowhere to hide.
    "Required report format (omitting any of these will be rejected by the reviewer):",
    "  CHANGED: <file path>:<line range> — <what you changed>",
    "  CHANGED: <file path>:<line range> — <what you changed>   (one line per file touched)",
    "  RATIONALE: <one paragraph why these specific edits action the next-action>",
    "  OUT OF SCOPE: <what you intentionally did NOT change>",
    "",
    "If you did not actually invoke a file-edit tool this turn, say `CHANGED: (none — reason: <one sentence>)` so the reviewer knows. Narration without edits is a rejection.",
  ].join("\n");
}

export function buildReviewerPrompt(
  proposition: string,
  verdict: ParsedDebateVerdict,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  // Only show the implementer's report (the most recent agent entry)
  // — reviewer doesn't need the full debate history again, just the
  // implementer's claims to verify.
  const lastImpl = [...transcript]
    .reverse()
    .find(
      (e) =>
        e.role === "agent" &&
        e.summary &&
        (e.summary as { kind?: string }).kind === "next_action_phase" &&
        (e.summary as { role?: string }).role === "implementer",
    );
  const implReport = lastImpl?.text ?? "(no implementer report found)";
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work the implementer's edits should advance",
    followUpLines: [
      "Verify not just that the implementer's changes match the next-action, but that they meaningfully advance the directive — flag if the changes only superficially address it.",
    ],
  });
  return [
    `You are now the REVIEWER (formerly CON debater). The IMPLEMENTER just made changes to the codebase to action the JUDGE's next-action recommendation.`,
    `Original proposition: "${proposition}"`,
    `Verdict next-action: ${verdict.nextAction}`,
    ...directiveBlock,
    "=== IMPLEMENTER'S REPORT ===",
    implReport,
    "=== END REPORT ===",
    "",
    "Your job: VERIFY the implementer's claims by independently inspecting the changed files. You have read-only tools (file-read / grep / find).",
    "1. Read the files the implementer claims to have changed. Confirm the changes are actually there.",
    "2. Look for issues: did the implementer break anything? Did they overreach (changes outside scope)? Did they leave gaps (changes that don't fully action the next-action)?",
    "3. Write a short review (under ~250 words). Use the format:",
    "   - VERIFIED: <what you confirmed is correctly done>",
    "   - CONCERNS: <issues you found, if any>",
    "   - GAPS: <what's still missing relative to the next-action>",
    "",
    "Be honest — your role is adversarial. If the implementation is bad or off-target, say so concretely.",
  ].join("\n");
}

export function buildSignoffPrompt(
  proposition: string,
  verdict: ParsedDebateVerdict,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  // Show implementer + reviewer entries; judge needs both to sign off.
  const phaseEntries = transcript.filter(
    (e) =>
      e.role === "agent" &&
      e.summary &&
      (e.summary as { kind?: string }).kind === "next_action_phase",
  );
  const phaseText = phaseEntries
    .map((e) => {
      const role = (e.summary as { role?: string }).role ?? "?";
      return `[${role.toUpperCase()}] ${e.text}`;
    })
    .join("\n\n");
  // 2026-05-03 (post-Phase-D follow-up): inline directive block extracted to shared helper.
  const directiveBlock = buildInlineDirectiveBlock(readDirective({ userDirective }), {
    contextLabel: "the work the implementation should advance",
    followUpLines: [
      "When deciding ACCEPTED / PARTIAL / REJECTED, factor in whether the implementation meaningfully advances the directive — not just whether it actions the verdict's next-action in isolation.",
    ],
  });
  return [
    `You are still the JUDGE. The IMPLEMENTER actioned your next-action recommendation; the REVIEWER inspected the changes. Now you sign off.`,
    `Original proposition: "${proposition}"`,
    `Verdict next-action: ${verdict.nextAction}`,
    ...directiveBlock,
    "=== BUILD-PHASE TRANSCRIPT ===",
    phaseText,
    "=== END ===",
    "",
    "You may use read-only tools to spot-check anything the reviewer flagged.",
    "Decide ONE outcome:",
    "  ACCEPTED — the implementation correctly actions the next-action; the run is done.",
    "  PARTIAL  — meaningful progress made, but real gaps remain that a future iteration should close.",
    "  REJECTED — implementation is wrong / harmful / off-target; revert.",
    "",
    "Write your decision on the FIRST line as one of: ACCEPTED, PARTIAL, REJECTED.",
    "Then a short paragraph (under ~150 words) justifying the call, citing the implementer's actual changes and the reviewer's concerns.",
  ].join("\n");
}

// Task #81: lenient parser for the JUDGE's JSON verdict. 2026-05-04
// (R11 wiring): the local three-strategy parser was replaced by
// repairAndParseJson, which adds soft repairs (trailing comma, smart
// quotes, missing braces) on top of the strict / fence / slice paths.
export interface ParsedDebateVerdict {
  winner: "pro" | "con" | "tie";
  confidence: "low" | "medium" | "high";
  proStrongest: string;
  conStrongest: string;
  proWeakest: string;
  conWeakest: string;
  decisive: string;
  nextAction: string;
}
export function parseDebateVerdict(raw: string): ParsedDebateVerdict | null {
  const obj = repairAndParseJson(raw)?.value;
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const winner = o.winner;
  const confidence = o.confidence;
  if (winner !== "pro" && winner !== "con" && winner !== "tie") return null;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return null;
  const str = (k: string): string =>
    typeof o[k] === "string" ? (o[k] as string).trim() : "";
  return {
    winner,
    confidence,
    proStrongest: str("proStrongest"),
    conStrongest: str("conStrongest"),
    proWeakest: str("proWeakest"),
    conWeakest: str("conWeakest"),
    decisive: str("decisive"),
    nextAction: str("nextAction"),
  };
}
// 2026-05-04 (R11 wiring): parseLooseJson removed — see repairJson.ts.

// T-Item-2 (2026-05-04): cross-stream judge synthesis. After K parallel
// debate streams settle (each with a per-stream verdict), the JUDGE
// fires ONE prompt that compares all K verdicts and picks the most
// informative one as the canonical run-level verdict.
//
// "Most informative" = strongest grounding, clearest decision-relevant
// tradeoff, sharpest nextAction. Self-evaluation bias is acknowledged
// (the judge wrote the per-stream verdicts AND picks among them) — same
// pattern as T199's parallel-proposition rank step.

export interface CrossStreamPick {
  /** The stream id that won (e.g. "stream-2"). */
  winnerStreamId: string;
  /** One sentence on why this verdict is the most informative. */
  rationale: string;
}

export interface CrossStreamJudgeStreamSummary {
  id: string;
  proposition: string;
  verdict: ParsedDebateVerdict | null;
}

export function buildCrossStreamJudgePrompt(args: {
  streams: readonly CrossStreamJudgeStreamSummary[];
  userDirective?: string;
}): string {
  const { streams, userDirective } = args;
  const directiveBlock = buildInlineDirectiveBlock(
    readDirective({ userDirective }),
    {
      contextLabel: "the work the canonical verdict's nextAction should target",
      followUpLines: [
        "Pick the verdict whose nextAction most concretely advances the directive — not the one that's most rhetorically clever.",
      ],
    },
  );
  const streamBlocks = streams.map((s) => {
    if (!s.verdict) {
      return [
        `=== STREAM ${s.id} ===`,
        `Proposition: "${s.proposition}"`,
        `Verdict: (none — stream did not settle)`,
        "=== END ===",
      ].join("\n");
    }
    const v = s.verdict;
    return [
      `=== STREAM ${s.id} ===`,
      `Proposition: "${s.proposition}"`,
      `Winner: ${v.winner.toUpperCase()} · confidence ${v.confidence}`,
      `PRO strongest: ${v.proStrongest}`,
      `CON strongest: ${v.conStrongest}`,
      `Decisive: ${v.decisive}`,
      `Next action: ${v.nextAction}`,
      "=== END ===",
    ].join("\n");
  });
  return [
    "You are the JUDGE synthesizing across K PARALLEL debate streams.",
    "Each stream debated a DIFFERENT proposition derived from the user directive. You issued a verdict for each.",
    ...directiveBlock,
    "Now pick the ONE stream whose verdict is the MOST INFORMATIVE — strongest grounding in concrete evidence, clearest decision-relevant tradeoff, sharpest actionable nextAction.",
    "",
    "Streams:",
    ...streamBlocks,
    "",
    "Output STRICT JSON only — no prose, no markdown fences:",
    '{"winnerStreamId": "<the id of the winning stream, e.g. stream-2>", "rationale": "<one sentence — why this verdict is most informative>"}',
  ].join("\n");
}

export function parseCrossStreamPick(
  raw: string,
  validIds: readonly string[],
): CrossStreamPick | null {
  const obj = repairAndParseJson(raw)?.value;
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const winnerStreamId =
    typeof o.winnerStreamId === "string" ? o.winnerStreamId.trim() : null;
  if (!winnerStreamId) return null;
  if (validIds.length > 0 && !validIds.includes(winnerStreamId)) return null;
  const rationale =
    typeof o.rationale === "string" ? o.rationale.trim() : "";
  return { winnerStreamId, rationale };
}

export async function rankParallelPropositions(
  judge: Agent,
  manager: AgentManager,
  directive: string,
  propositions: readonly string[],
): Promise<number | null> {
  if (propositions.length === 0) return null;
  if (propositions.length === 1) return 0;
  const prompt = [
    "You are the JUDGE picking the most INFORMATIVE proposition to debate.",
    "",
    `User directive (the work this debate informs): ${directive}`,
    "",
    `Candidate propositions (${propositions.length}):`,
    ...propositions.map((p, i) => `  [${i}] ${p}`),
    "",
    "Pick the ONE that maximizes:",
    "1. Debatable surface area (genuinely two-sided, not a foregone conclusion)",
    "2. Grounded in the directive's real concerns (not tangential)",
    "3. Non-trivial framing (\"X is good\" with no qualifier is too vague; \"X is the right tradeoff under constraint Y\" is strong)",
    "",
    "Output STRICT JSON only — no prose, no markdown fences:",
    '{"pickedIndex": <0-based integer>, "rationale": "<one-sentence why this is the most informative debate frame>"}',
  ].join("\n");
  let raw: string;
  try {
    const ctrl = new AbortController();
    const result = promptWithFailoverAuto(judge, prompt, {
      signal: ctrl.signal,
      manager,
      agentName: "swarm-read",
      describeError: (e) => describeSdkError(e),
    });
    const settled = (await result) as { data?: { parts?: Array<{ type: string; text: string }> } };
    raw = settled.data?.parts?.find((p) => p.type === "text")?.text ?? "";
  } catch {
    return null;
  }
  if (!raw || raw.trim().length === 0) return null;
  const text = (extractText(raw) ?? raw).trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const idx = (parsed as { pickedIndex?: unknown }).pickedIndex;
  if (typeof idx !== "number" || !Number.isInteger(idx)) return null;
  if (idx < 0 || idx >= propositions.length) return null;
  return idx;
}