// 2026-05-02 (council improvement #2 + #4): per-agent position
// extraction. Agents end every turn with a `### MY POSITION` block —
// one short statement of their current best answer to the directive.
// This module:
//   - extracts that block from one turn's text
//   - finds an agent's most-recent position across the transcript
//     (used by buildCouncilPrompt for Round-2+ "your prior position
//     was X, did you keep or change it?")
//   - composes a "Per-agent positions" deliverable section showing
//     each agent's final position side-by-side
//
// Pure functions — no I/O. Sister module to roleDiffDeliverable.ts;
// both extract a structured tail block from agent turns. The two
// modules deliberately don't share a regex helper: the heading text
// is part of each preset's contract and could drift independently.

import type { TranscriptEntry } from "../types.js";
import type { DeliverableSection } from "./deliverable.js";

export interface AgentPosition {
  agentIndex: number;
  /** The text under the `### MY POSITION` heading. Empty when this
   *  agent never produced one across the whole run. */
  body: string;
  /** True when at least one turn from this agent had the heading. */
  produced: boolean;
}

/** Extract the body that follows a `### MY POSITION` heading. Returns
 *  null when the heading isn't present.
 *
 *  Tolerant to:
 *    - any whitespace after the heading (incl. trailing colon)
 *    - case variation ("my position" vs "MY POSITION")
 *    - leading/trailing blank lines in the body
 *
 *  Body extends until end-of-text or the next H1/H2/H3 heading. */
export function extractPositionBlock(text: string): string | null {
  if (!text) return null;
  const headingRe = /^[ \t]*###[ \t]+MY[ \t]+POSITION[ \t]*:?[ \t]*$/im;
  const m = headingRe.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const nextHeading = /^[ \t]*#{1,3}[ \t]+\S/m.exec(after);
  const body = nextHeading ? after.slice(0, nextHeading.index) : after;
  return body.trim();
}

/** Walk the transcript newest-first; return the most recent
 *  `### MY POSITION` body for the given agentIndex. Returns null when
 *  the agent has never produced one (e.g. round 1 hasn't happened yet,
 *  or the agent ignored the contract). */
export function getLastPositionForAgent(
  transcript: readonly TranscriptEntry[],
  agentIndex: number,
): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role !== "agent" || e.agentIndex !== agentIndex) continue;
    const body = extractPositionBlock(e.text);
    if (body !== null) return body;
  }
  return null;
}

// 2026-05-04 (T181): convergence-too-fast detection. R2+ agents must
// own KEEP / CHANGE explicitly; if every R2 agent says KEEP (zero
// CHANGEs), the council converged before exposure to dissent and
// we should fire a forced-contrarian round.

/** Parse the verb at the top of a position body. Recognizes leading
 *  "KEEP:" or "CHANGE:" (case-insensitive). Returns null when neither
 *  is detected (typically R1 where the contract is just a bare
 *  position with no KEEP/CHANGE prefix). */
export function parsePositionVerb(body: string | null): "KEEP" | "CHANGE" | null {
  if (!body) return null;
  // Allow leading whitespace + first word + optional colon.
  const m = body.match(/^[\s>]*?(KEEP|CHANGE)\b/i);
  if (!m) return null;
  return m[1]!.toUpperCase() as "KEEP" | "CHANGE";
}

/** Count how many agents flipped (CHANGE) vs held (KEEP) in their
 *  most-recent position for the given round. Inputs:
 *    - transcript: full run-so-far
 *    - round: which round to count (1, 2, 3, ...)
 *    - agentCount: total agents
 *  An agent that didn't produce a position for that round, or whose
 *  position lacked KEEP/CHANGE prefix, is counted in `unparsed`. */
export interface PositionFlipCounts {
  keeps: number;
  changes: number;
  unparsed: number;
}
export function countPositionFlips(
  transcript: readonly TranscriptEntry[],
  round: number,
  agentCount: number,
): PositionFlipCounts {
  let keeps = 0;
  let changes = 0;
  let unparsed = 0;
  for (let agentIndex = 1; agentIndex <= agentCount; agentIndex++) {
    // Find this agent's position from the given round. Walk newest-
    // first to pick the latest entry tagged with that round.
    let body: string | null = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i];
      if (e.role !== "agent" || e.agentIndex !== agentIndex) continue;
      // Position summaries carry the round in summary.kind === "council_draft"
      const summary = e.summary;
      if (
        summary?.kind === "council_draft" &&
        (summary as { round?: number }).round === round
      ) {
        body = extractPositionBlock(e.text);
        break;
      }
    }
    const verb = parsePositionVerb(body);
    if (verb === "KEEP") keeps++;
    else if (verb === "CHANGE") changes++;
    else unparsed++;
  }
  return { keeps, changes, unparsed };
}

/** Collect each agent's most-recent position across the full
 *  transcript. Returns one entry per agentIndex in 1..agentCount —
 *  agents that never complied get `produced: false` + empty body so
 *  the reader still sees what was missing. */
export function collectAgentPositions(
  transcript: readonly TranscriptEntry[],
  agentCount: number,
): AgentPosition[] {
  const out: AgentPosition[] = [];
  for (let agentIndex = 1; agentIndex <= agentCount; agentIndex++) {
    const body = getLastPositionForAgent(transcript, agentIndex) ?? "";
    out.push({ agentIndex, body, produced: body.length > 0 });
  }
  return out;
}

/** Build a "Per-agent positions" deliverable section. Each agent gets
 *  a sub-heading (`### Agent N`) followed by their final position
 *  body (or a placeholder when they never produced one). */
export function buildCouncilPositionsSection(
  transcript: readonly TranscriptEntry[],
  agentCount: number,
): DeliverableSection {
  const positions = collectAgentPositions(transcript, agentCount);
  const body = positions
    .map((p) =>
      p.produced
        ? `### Agent ${p.agentIndex}\n\n${p.body}`
        : `### Agent ${p.agentIndex}\n\n_(agent did not produce a \`### MY POSITION\` block in this run)_`,
    )
    .join("\n\n");
  return {
    title: "Per-agent positions (latest)",
    body,
  };
}
