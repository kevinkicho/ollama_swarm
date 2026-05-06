// 2026-05-02 (round-robin improvement #1): rotating dispositions for
// the structured deliberation framework. When NO roles are configured,
// each turn cycles through these four lenses — every turn deliberately
// adds a distinct kind of value, no two consecutive turns can be the
// same character.
//
// Calibrated to a small fixed set: 4 dispositions covers the most
// useful axes of deliberation (push back / consolidate / surface gaps /
// move forward). More dispositions would dilute; fewer wouldn't cycle
// before agents repeat themselves.

import type { TranscriptEntry } from "../types.js";
import { roleForAgent, type SwarmRole } from "./roles.js";
import type { Topology } from "../../../shared/src/topology.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickAnswerSectionTitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import {
  extractNextActions,
  formatNextActionsMarkdown,
} from "./qualityPasses.js";
import { parseConvergenceSignal } from "./convergenceSignal.js";

export interface RoundRobinDisposition {
  name: string;
  framing: string;
}

export const DISPOSITIONS: readonly RoundRobinDisposition[] = [
  {
    name: "Critic",
    framing:
      "Find weaknesses in what's been said. Cite the specific claim you're challenging + your reason. Don't be contrary for its own sake — name the gap or unfounded assumption.",
  },
  {
    name: "Synthesizer",
    framing:
      "Distill what peers AGREED on (consensus) and what they DISAGREED on (open tradeoffs). Cite who said what. Surface 1-2 sentences that capture the current state of the discussion.",
  },
  {
    name: "Gap-finder",
    framing:
      "Name what HASN'T been addressed yet. What did the directive ask for that no peer has touched? What perspective (security, performance, ergonomics, cost) is missing? Cite specifics, not generalities.",
  },
  {
    name: "Builder",
    framing:
      "Propose ONE concrete next action the team should take. Name files to touch, decisions to make, or experiments to run. Be specific enough that a peer could execute on it. Build on what's been said; don't restart.",
  },
];

/** Pure helper — get the disposition for a 1-indexed turn number.
 *  Cycles through DISPOSITIONS in order. Pure — exported for tests. */
export function getDispositionForTurn(turnNumber: number): RoundRobinDisposition {
  const idx = ((turnNumber - 1) % DISPOSITIONS.length + DISPOSITIONS.length) % DISPOSITIONS.length;
  return DISPOSITIONS[idx];
}

// T185 (2026-05-04): voted-next disposition. Each agent ends their
// turn with `NEXT-DISPOSITION VOTE: <name> — <reason>`. Runner
// aggregates the last few votes to pick the next disposition; falls
// back to mechanical rotation when votes are absent or tied.

/** Parse a NEXT-DISPOSITION VOTE line out of an agent's text. Returns
 *  null when no recognizable vote is present. Tolerant to whitespace,
 *  case, and the trailing reason. */
export function extractDispositionVote(text: string | undefined): string | null {
  if (!text) return null;
  // Match "NEXT-DISPOSITION VOTE: <name>" with the name being one of
  // the disposition names (case-insensitive). Allow "next disposition vote"
  // too (model may drop the hyphen).
  const m = text.match(
    /NEXT[- ]DISPOSITION\s+VOTE\s*:\s*(critic|synthesizer|gap-?finder|builder)\b/i,
  );
  if (!m) return null;
  // Normalize gap-finder vs gapfinder.
  const raw = m[1]!.toLowerCase().replace(/-?finder/, "-finder");
  return raw;
}

/** Pick the next disposition based on votes from the last `lookback`
 *  agent turns. Returns the disposition that won the most votes;
 *  falls back to the mechanical rotation when no votes / tied votes /
 *  unrecognized vote names. Pure — exported for tests. */
export function pickNextDisposition(
  transcript: readonly TranscriptEntry[],
  fallbackTurnNumber: number,
  lookback: number = 4,
): RoundRobinDisposition {
  const recentAgentTurns = transcript
    .filter((e) => e.role === "agent")
    .slice(-lookback);
  const tally: Record<string, number> = {};
  for (const e of recentAgentTurns) {
    const vote = extractDispositionVote(e.text);
    if (!vote) continue;
    // Match against DISPOSITIONS catalog (lowercased name).
    const matchIdx = DISPOSITIONS.findIndex(
      (d) => d.name.toLowerCase().replace(/[ -]/g, "-") === vote,
    );
    if (matchIdx === -1) continue;
    const name = DISPOSITIONS[matchIdx]!.name;
    tally[name] = (tally[name] ?? 0) + 1;
  }
  // Pick the highest-vote disposition. Ties + no-votes → mechanical fallback.
  const entries = Object.entries(tally);
  if (entries.length === 0) return getDispositionForTurn(fallbackTurnNumber);
  entries.sort((a, b) => b[1] - a[1]);
  // Tied between top-2? Fall back to rotation rather than picking arbitrarily.
  if (entries.length >= 2 && entries[0]![1] === entries[1]![1]) {
    return getDispositionForTurn(fallbackTurnNumber);
  }
  const winner = DISPOSITIONS.find((d) => d.name === entries[0]![0]);
  return winner ?? getDispositionForTurn(fallbackTurnNumber);
}

// 2026-05-02 (round-robin improvement #4): structured-deliberation
// final synthesis. Mirrors buildRoleDiffSynthesisPrompt but for the
// no-roles structured-deliberation case. Lead distills the whole
// transcript into Consensus / Disagreements / Recommended next step.
export function buildStructuredSynthesisPrompt(
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
  // 2026-05-02 (improvement #5): directive-aware synthesis. When a
  // directive is set the synthesis MUST answer it directly — adds a
  // dedicated "Answer to directive" section and reframes
  // "Recommended next step" as the next action toward the directive.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the team was deliberating)",
  });
  const structure = dirCtx.hasDirective
    ? [
        "STRUCTURE your response as:",
        "1. **Answer to directive** — direct response to the user's question / request. State what the team concluded, not how it deliberated.",
        "2. **Consensus** — what every agent agreed on while resolving the directive.",
        "3. **Disagreements** — where agents still hold different positions on the directive. Name the agents and their stances.",
        "4. **Cross-round flips** — positions that CHANGED between rounds (signal of weak ground; likely needs more evidence). Name the agent + the prior position + the new position. If no notable flips, say so explicitly.",
        "5. **Recommended next step** — ONE concrete next action toward the directive. Cite files / decisions / experiments. Build on the Builder-disposition turns.",
        "6. **Open questions** — anything the Gap-finder turns surfaced about the directive that the team didn't resolve.",
      ]
    : [
        "STRUCTURE your response as:",
        "1. **Consensus** — what every agent (including you) converged on. State as a direct claim, not a meta-observation.",
        "2. **Disagreements** — where agents still hold different positions. Name the agents and their stances.",
        "3. **Cross-round flips** — positions that CHANGED between rounds (signal of weak ground; likely needs more evidence). Name the agent + prior position + new position. If no notable flips, say so explicitly.",
        "4. **Recommended next step** — ONE concrete next action. Cite files / decisions / experiments. Build on the Builder-disposition turns from the discussion.",
        "5. **Open questions** — anything the Gap-finder turns surfaced that the team didn't resolve.",
      ];
  return [
    `You are Agent 1, the deliberation synthesis lead. The team just finished ${totalRounds} round${totalRounds === 1 ? "" : "s"} of structured deliberation across rotating dispositions (Critic / Synthesizer / Gap-finder / Builder).`,
    "Your job NOW is to produce a SINGLE consolidated answer that integrates the whole discussion.",
    "",
    ...directiveBlock,
    ...structure,
    "",
    "Keep under ~500 words. Be specific. Cite file paths when relevant.",
    "",
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — agents largely agree; further rounds would only restate consensus.",
    "  CONVERGENCE: medium — partial consensus with real open questions still in play.",
    "  CONVERGENCE: low    — significant unresolved disagreement; more rounds would help.",
    "",
    "=== FULL TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

export function buildRoleDiffSynthesisPrompt(
  roles: readonly SwarmRole[],
  transcript: readonly TranscriptEntry[],
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const role =
        e.agentIndex !== undefined ? roleForAgent(e.agentIndex, roles) : null;
      const label = role
        ? `Agent ${e.agentIndex} (${role.name})`
        : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");
  const roleNames = roles.map((r) => r.name).join(", ");

  return [
    `You are Agent 1, the role-diff synthesis lead. The swarm just finished N rounds of discussion with agents wearing different roles: ${roleNames}.`,
    "Your job NOW is to produce a SINGLE consolidated cross-role view that integrates every role's findings.",
    "",
    "STRUCTURE your response as:",
    "1. **Cross-role agreement** — what every role independently flagged. State as direct claims, cite which role surfaced each (e.g. \"Architect + Tester both noted the absence of integration tests in src/api/\").",
    "2. **Role-specific findings** — one short bullet per role naming its single most important standalone observation that the others didn't make.",
    // T186 (2026-05-04): role-pair conflicts. Pre-T186 the synthesis
    // surfaced general "disagreements" but never explicitly RESOLVED
    // them. Now: name the specific role-pair, state both sides, then
    // PICK A SIDE with reasoning (or explicitly say "this is a real
    // ongoing tradeoff the user must decide"). Every conflict left
    // unresolved is a deferred decision.
    "3. **Role-pair conflicts (RESOLVE, don't just list)** — for each pair of roles pulling in opposite directions, render as:",
    "    `<Role A> vs <Role B>: <one-line claim from A> ↔ <one-line counter from B>`",
    "    `Resolution: <which side wins for this directive AND why> — OR — \"Real tradeoff: user decides\" with context for that decision.`",
    "    Common pairs to watch: Performance ↔ Security (caching vs staleness); Architect ↔ Implementer (clean shape vs ship-now); Tester ↔ Performance (coverage vs hot-path overhead). If no pairs conflicted, write `_no role-pair conflicts surfaced this run_`.",
    "4. **Next action** — ONE concrete next step grounded in the cross-role view AND the conflict resolutions above.",
    "",
    "Keep it under ~400 words. Cite file paths from the discussion. Do NOT just restate each role's draft — synthesize across them.",
    "",
    // Phase B (Task #100): convergence signal — same line shape as
    // CouncilRunner so any UI/parser pattern transfers.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — roles largely agree; further rounds would only restate the cross-role view.",
    "  CONVERGENCE: medium — partial cross-role agreement with real open tensions still in play.",
    "  CONVERGENCE: low    — roles still pulling in different directions; more rounds would help.",
    "",
    "=== FULL ROLE-DIFF TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

// Phase B (Task #100): scan a synthesis response for the
// "CONVERGENCE: high|medium|low" line. Mirrors parseCouncilConvergence
// in CouncilRunner.ts.
// 2026-05-03 (Phase A): both parsers consolidated into the shared
// `convergenceSignal.ts` module. This re-export preserves the legacy
// public name for external callers.
export { parseConvergenceSignal as parseRoleDiffConvergence } from "./convergenceSignal.js";

// 2026-05-04 (T1.1 universal deliverable): build deliverable sections
// for plain round-robin (no roles). Mirrors CouncilRunner's section
// shape: directive (if set), final synthesis, last-round per-agent
// turns. Quality augmentation (rubric/critic) is skipped — round-robin
// doesn't carry a derivedRubric — but next-actions extraction is
// always free (pure parser) so it still runs.
export interface RoundRobinPromptContext {
  turnsTaken: number;
  transcript: readonly TranscriptEntry[];
  roles?: readonly SwarmRole[];
  userDirective?: string;
  agentIndex: number;
  totalRounds: number;
  round: number;
  topology?: Topology;
}

export function buildRoundRobinTurnPrompt(ctx: RoundRobinPromptContext): string {
  const {
    turnsTaken: turnNumber,
    transcript,
    roles,
    userDirective,
    agentIndex,
    totalRounds,
    round,
  } = ctx;
  const disposition = !roles
    ? pickNextDisposition(transcript, turnNumber)
    : null;
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label = roles
        ? `Agent ${e.agentIndex} (${roleForAgent(e.agentIndex ?? 1, roles).name})`
        : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  const role = roles ? roleForAgent(agentIndex, roles) : null;
  const header = role
    ? `You are Agent ${agentIndex} in a swarm of collaborating AI engineers reviewing a cloned GitHub project. Your role is "${role.name}".`
    : disposition
      ? `You are Agent ${agentIndex} in a structured deliberation. This turn, you take the **${disposition.name}** disposition.`
      : `You are Agent ${agentIndex} in a swarm of collaborating AI engineers reviewing a cloned GitHub project.`;
  const roleGuidance = role ? [`As the ${role.name}: ${role.guidance}`, ""] : [];
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this deliberation must resolve)",
  });
  const directive = dirCtx.directive;
  const dispositionBlock = disposition
    ? [
        `**${disposition.name.toUpperCase()} disposition this turn:** ${disposition.framing}`,
        "",
        "**ACTIVE-DISAGREEMENT RULE (every turn):** You MUST do at least ONE of: (a) challenge a specific prior point with reasoning, (b) add a NEW dimension peers haven't named, or (c) call out a real tradeoff being glossed. Never just agree or restate. If you have nothing to push on, say so explicitly + name what's still unclear.",
        "",
        "**NEXT-DISPOSITION VOTE (every turn):** End your response with a one-line vote on what should come NEXT. Format:",
        "    NEXT-DISPOSITION VOTE: critic|synthesizer|gap-finder|builder — <one-line why>",
        "Vote based on what the discussion needs, not what's mechanically next. If everyone keeps voting the same lens, the runner will keep firing it until the need shifts.",
        "",
      ]
    : [];

  const deliverableBlock = role
    ? [
        "**MY DELIVERABLE CONTRACT (every turn, role-diff):** End your prose with a `### MY DELIVERABLE` heading followed by your role's concrete contribution.",
        role.deliverableHint
          ? `For your role (${role.name}): ${role.deliverableHint}`
          : `For your role (${role.name}): a concrete contribution toward the directive — not commentary on it.`,
        "Even if your role's piece doesn't change this round, write what your CURRENT best answer is — peers and the synthesis lead read this block, not your prose.",
        "",
        ...(round >= 2
          ? [
              "**CROSS-ROLE PEER REVIEW (R2+):** BEFORE your `### MY DELIVERABLE` block, write:",
              "    ### PEER REVIEW",
              "    Reviewing: <Role X's deliverable from round R-1>",
              "    Reaction: <BUILD ON: <one line>> | <PUSH BACK: <one line + grounding>> | <NEEDS WORK: <what's missing>>",
              "Pick a peer whose stance you can engage substantively — not your own role. Be specific; ground reactions in file paths or peer's claims when possible.",
              "",
            ]
          : []),
      ]
    : [];

  return [
    header,
    `This is discussion round ${round} of ${totalRounds}. (Total turns so far: ${turnNumber}.)`,
    ...roleGuidance,
    ...directiveBlock,
    ...dispositionBlock,
    ...deliverableBlock,
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "REQUIRED — BEFORE writing your prose response:",
    "  1. Use the `read` tool on AT LEAST ONE file from the repo. Pick a file relevant to your role (e.g. Architect → README.md or main entry point; Tester → a test file; Security → auth/config; Performance → hot-path code).",
    "  2. If a peer in the transcript cited a specific file path you haven't seen, read THAT file before agreeing or pushing back.",
    "  3. If your prior turn made a claim about file contents, re-verify with a tool call before defending or revising the claim.",
    "Failing to make at least one tool call means your turn is uninformed and will be flagged as such by reviewers.",
    "",
    "Round 1: skim README.md and the top-level tree before opining. Later rounds: read the specific files needed to verify peer claims.",
    "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
    "You may @mention another agent (e.g. @Agent2) to address them directly.",
    "",
    ...(directive.length > 0
      ? role
        ? [
            "Goals of this deliberation:",
            "1. Read the repo just enough to ground your role's deliverable in real code (not filename guesses).",
            `2. Through your role (${role.name}), produce YOUR specialist piece of the directive's answer. Other roles handle the other pieces — focus on yours.`,
            "3. By the final round the team should have converged on a coherent answer to the directive built from each role's deliverable, with the synthesis lead consolidating.",
            "",
          ]
        : [
            "Goals of this deliberation:",
            "1. Read the repo just enough to ground your take on the directive in real code (not filename guesses).",
            "2. Through your assigned disposition, advance the team's answer to the directive — challenge a peer's framing of it, surface what they're missing about it, or propose a concrete step toward it.",
            "3. By the final round the team should have converged on: a clear plan for the directive, what's risky about it, and what the next concrete step is.",
            "",
          ]
      : [
          "Goals of this discussion:",
          "1. Figure out what this project is and who it is for.",
          "2. Identify what is working and what is missing.",
          "3. Propose one concrete next action the swarm should take.",
          "",
        ]),
    "=== SHARED TRANSCRIPT ===",
    transcriptText || "(empty — you are first to speak)",
    "=== END TRANSCRIPT ===",
    "",
    role
      ? `Now respond as Agent ${agentIndex} (${role.name}), through the lens of your role. Tool-call first, then prose, then your \`### MY DELIVERABLE\` block.`
      : `Now respond as Agent ${agentIndex}. Tool-call first, then prose.`,
  ].join("\n");
}

export function buildRoundRobinDeliverableSections(input: {
  cfg: { userDirective?: string; agentCount: number; rounds: number };
  transcript: readonly TranscriptEntry[];
  actualRounds: number;
}): Array<{ title: string; body: string }> {
  const dirCtx = readDirective(input.cfg);
  const sections: Array<{ title: string; body: string }> = [];

  // Directive section first when set, so the deliverable opens with
  // the question being answered.
  const directiveSection = maybeDirectiveSection(dirCtx);
  if (directiveSection) sections.push(directiveSection);

  // Final synthesis — written by runStructuredSynthesisPass right
  // before this helper runs. Tagged with summary.kind="role_diff_synthesis"
  // (the structured-deliberation case reuses that envelope).
  const synthesisEntry = [...input.transcript]
    .reverse()
    .find(
      (e) =>
        e.role === "agent" &&
        e.summary?.kind === "role_diff_synthesis" &&
        e.summary.roles === 0,
    );
  const synthesisText = synthesisEntry?.text.trim() ?? "";
  sections.push({
    title: pickAnswerSectionTitle(dirCtx, {
      withDirective: "Answer to directive",
      withoutDirective: "Final synthesis",
    }),
    body:
      synthesisText.length > 0
        ? synthesisText
        : "_(synthesis pass returned empty; transcript may have partial discussion)_",
  });

  // Per-agent last-round turns so the reader sees the disposition
  // rotation that produced the synthesis. Filter to the final round
  // only — full transcript would dwarf the synthesis.
  const finalRoundTurns: Array<{ agentIndex?: number; text: string }> = [];
  // The transcript has agent entries tagged by round via summary.kind=
  // "agent_turn"; without that, fall back to the last cfg.agentCount
  // agent entries (one per agent in the final round under round-robin).
  const agentEntries = input.transcript.filter((e) => e.role === "agent");
  const tail = agentEntries.slice(-input.cfg.agentCount);
  for (const e of tail) {
    finalRoundTurns.push({ agentIndex: e.agentIndex, text: e.text.trim() });
  }
  sections.push({
    title: `Round ${input.actualRounds} — final-round turns (rotating dispositions)`,
    body:
      finalRoundTurns.length > 0
        ? finalRoundTurns
            .map((t) => `### Agent ${t.agentIndex ?? "?"}\n\n${t.text}`)
            .join("\n\n")
        : "_(no final-round turns captured)_",
  });

  // Always-free next-actions extraction (pure parser) so the
  // deliverable lands with concrete recommendations the user can chase.
  const baseText = sections
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n");
  const actions = extractNextActions(baseText);
  sections.push({
    title: "Next actions",
    body: formatNextActionsMarkdown(actions),
  });

  return sections;
}