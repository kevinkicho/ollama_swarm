import type { TranscriptEntry } from "../types.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { getLastPositionForAgent } from "./councilPosition.js";

export function buildCouncilSynthesisPrompt(
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this council was answering)",
  });

  const structure = dirCtx.hasDirective
    ? [
        "STRUCTURE your response as:",
        "1. **Answer to directive** — direct response to the user's question. State what the council concluded, not how it deliberated.",
        "2. **Consensus** — what every agent (including you) converged on while resolving the directive. State as a direct claim. **Weigh each agent's contribution by their CONFIDENCE tag** (high > medium > low) — don't treat 3 low-confidence agreements as equivalent to 1 high-confidence agreement.",
        "3. **Disagreements** — where agents still hold different positions on the directive. Name the agents, their stances, AND their confidence tags.",
        "4. **Minority report** — when at least one agent's `### MY POSITION` diverges from the consensus, name them and state their strongest argument **verbatim** from their last position. **A high-confidence minority dissent should be weighed seriously even when numerically outvoted.** If the council genuinely converged with no dissent, write `_consensus reached — no minority position_`. Do NOT invent dissent for show.",
        "5. **Next action** — ONE concrete next step toward the directive. Cite files / decisions / experiments. If no action is needed, say so.",
        "",
      ]
    : [
        "STRUCTURE your response as:",
        "1. **Consensus** — what every agent (including you) converged on. State it as a direct claim, not a meta-observation. **Weigh each agent's contribution by their CONFIDENCE tag** — don't treat 3 low-confidence agreements as equivalent to 1 high-confidence agreement.",
        "2. **Disagreements** — where agents still hold different positions. Name the agents, their stances, AND their confidence tags.",
        "3. **Minority report** — when at least one agent's `### MY POSITION` diverges from the consensus, name them and state their strongest argument **verbatim** from their last position. **A high-confidence minority dissent should be weighed seriously even when numerically outvoted.** If the council genuinely converged with no dissent, write `_consensus reached — no minority position_`. Do NOT invent dissent for show.",
        "4. **Next action** — ONE concrete next step the swarm or user should take, given the council's findings. If no action is needed, say so.",
        "",
      ];

  return [
    `You are Agent 1, the council's synthesis lead. The council just finished ${totalRounds} round${totalRounds === 1 ? "" : "s"} of independent drafts + reveal/revise.`,
    "Your job NOW is to produce a SINGLE consolidated answer that integrates every agent's final position.",
    "",
    ...directiveBlock,
    ...structure,
    "Keep it under ~500 words. Be specific. Cite file paths or peer claims when relevant. Do not just summarize the drafts — synthesize them.",
    "",
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — agents largely agree; further rounds would only restate the consensus.",
    "  CONVERGENCE: medium — partial consensus with real open questions still in play.",
    "  CONVERGENCE: low    — significant unresolved disagreement; more rounds would help.",
    "",
    "=== FULL COUNCIL TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

export function buildCouncilPrompt(
  agentIndex: number,
  round: number,
  totalRounds: number,
  snapshot: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const visible =
    round === 1 ? snapshot.filter((e) => e.role !== "agent") : snapshot;

  const transcriptText = visible
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const header = `You are Agent ${agentIndex} in a council of AI engineers reviewing a cloned GitHub project.`;
  const roundIntent =
    round === 1
      ? "This is ROUND 1 — your independent first draft. You cannot see the other agents' drafts; that is deliberate. Answer without anchoring on anyone else."
      : `This is ROUND ${round} of ${totalRounds} — revision. The other agents' prior drafts are in the transcript below. Revise your own position: keep what still holds, change what a peer's draft convinced you of, explicitly disagree where you think they're wrong. Do not just agree.`;

  const transcriptLabel =
    round === 1
      ? "=== SEED + ANY HUMAN INPUT (peer drafts hidden this round) ==="
      : "=== COUNCIL TRANSCRIPT SO FAR ===";

  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this council is answering)",
  });
  const directive = dirCtx.directive;

  const priorPosition =
    round > 1 ? getLastPositionForAgent(snapshot, agentIndex) : null;
  const priorPositionBlock =
    round > 1
      ? [
          "=== YOUR PRIOR POSITION (from last round) ===",
          priorPosition ?? "_(you did not produce a `### MY POSITION` block last round — start fresh this round)_",
          "=== END PRIOR POSITION ===",
          "",
        ]
      : [];

  const positionContract =
    round === 1
      ? [
          "**POSITION CONTRACT (every turn):** End your response with:",
          "    ### MY POSITION",
          "    <one short sentence — ≤300 chars — your direct answer to the directive (or to 'what should this project do' when no directive). This is your anchor against drift in later rounds.>",
          "    CONFIDENCE: high|medium|low — <one-line why you trust this position at this strength>",
          "    GROUNDING: <at least one citation — file path (e.g. src/foo.ts:42), test name (e.g. tests/auth.test.ts \"should reject expired tokens\"), command output (e.g. `git log` shows 3 recent commits to auth/), or README claim. NO grounding = re-prompted.>",
          "",
        ]
      : [
          "**STEELMAN STEP (R2+ only):** BEFORE your `### MY POSITION` block, write:",
          "    ### STEELMAN OF PEER POSITION",
          "    <Pick the peer position you most disagree with. State it in its strongest, most well-grounded form — better than the peer themselves did. ~1-2 sentences. Cite which agent + roughly which round.>",
          "",
          "**POSITION CONTRACT (every turn):** End your response with:",
          "    ### MY POSITION",
          "    KEEP: <restate your prior position verbatim>   — OR —   CHANGE: <new one-sentence position>",
          "    WHY: <one line — what specifically convinced you to keep or change. Cite the agent + their argument when CHANGE. After steelmanning, mention what the steelman did NOT change about your position.>",
          "    CONFIDENCE: high|medium|low — <one-line why you trust this position at this strength after the steelman exercise>",
          "    GROUNDING: <at least one citation — file path / test name / command output / README claim. NO grounding = re-prompted.>",
          "",
          "Drift without an explicit CHANGE is the failure mode this contract exists to prevent. If you find yourself softening your prior position without naming who convinced you and how, KEEP it.",
          "",
        ];

  const goals = directive.length > 0
    ? [
        "Goals of this council:",
        "1. Read the repo just enough to ground your answer to the directive in real code (not filename guesses).",
        "2. Round 1: produce YOUR independent answer to the directive. Don't anchor on peers — you cannot see them.",
        "3. Round 2+: revise vs. prior round. Keep what still holds, change what a peer's draft genuinely convinced you of, explicitly disagree where you think they're wrong.",
        "",
      ]
    : [
        "Goals of this discussion:",
        "1. Figure out what this project is and who it is for.",
        "2. Identify what is working and what is missing.",
        "3. Propose one concrete next action the swarm should take.",
        "",
      ];

  return [
    header,
    roundIntent,
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "Round 1: skim README.md and the top-level tree before opining. Later rounds: re-read files when a peer's claim needs checking.",
    "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
    "",
    ...directiveBlock,
    ...priorPositionBlock,
    ...positionContract,
    ...goals,
    transcriptLabel,
    transcriptText || "(empty — you are writing the first entry)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex}. End with your \`### MY POSITION\` block.`,
  ].join("\n");
}