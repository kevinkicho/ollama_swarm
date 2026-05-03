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
