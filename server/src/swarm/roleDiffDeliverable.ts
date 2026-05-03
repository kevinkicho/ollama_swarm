// 2026-05-02 (role-diff improvement #4): portable deliverable for the
// role-diff preset. Extracts each role's latest `### MY DELIVERABLE`
// block from the transcript and composes a PR-shaped markdown doc:
//   - User directive (or "Open analysis" if absent)
//   - One section per role with that role's last deliverable block
//   - Synthesis text from the role-diff synthesis pass (when present)
//
// Pure functions — no I/O. The runner calls writeDeliverable() with the
// composed sections; that helper handles atomic write + transcript event.

import type { TranscriptEntry } from "../types.js";
import type { SwarmRole } from "./roles.js";
import { roleForAgent } from "./roles.js";
import type { DeliverableSection } from "./deliverable.js";

export interface RoleDeliverable {
  roleName: string;
  agentIndex: number;
  /** The text under the `### MY DELIVERABLE` heading. Empty when the
   *  role never produced one across the whole run. */
  body: string;
  /** True when at least one turn from this role had the heading; false
   *  when the role never complied — the section still renders so the
   *  reader sees what's missing. */
  produced: boolean;
}

/** Pull the body that follows a `### MY DELIVERABLE` heading from one
 *  agent turn's text. Returns null when the heading isn't present.
 *  Body extends until end-of-text or the next H2/H3 heading at the
 *  same depth or shallower (so a later `### Other-Heading` ends it).
 *
 *  Tolerant to:
 *    - any whitespace after the heading
 *    - case variation in the literal "MY DELIVERABLE"
 *    - leading/trailing blank lines in the body */
export function extractDeliverableBlock(text: string): string | null {
  if (!text) return null;
  const headingRe = /^[ \t]*###[ \t]+MY[ \t]+DELIVERABLE[ \t]*:?[ \t]*$/im;
  const m = headingRe.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  // Body ends at the next H1/H2/H3 heading.
  const nextHeading = /^[ \t]*#{1,3}[ \t]+\S/m.exec(after);
  const body = nextHeading ? after.slice(0, nextHeading.index) : after;
  return body.trim();
}

/** Walk the full transcript, find the LAST agent-turn per agentIndex
 *  that produced a `### MY DELIVERABLE` block, and return one entry
 *  per role in the catalog (in catalog order). Roles with no producing
 *  turn get `produced: false` + empty body so the reader still sees
 *  what was missing. */
export function collectRoleDeliverables(
  transcript: readonly TranscriptEntry[],
  roles: readonly SwarmRole[],
  agentCount: number,
): RoleDeliverable[] {
  // Index = agentIndex (1-based). Find each agent's most-recent
  // deliverable block by scanning the transcript newest → oldest.
  const lastByAgent = new Map<number, string>();
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role !== "agent" || e.agentIndex === undefined) continue;
    if (lastByAgent.has(e.agentIndex)) continue;
    const body = extractDeliverableBlock(e.text);
    if (body !== null) lastByAgent.set(e.agentIndex, body);
  }
  // Emit in agent-index order (1..agentCount). Each agent's role is
  // resolved via the same modulo-wrap helper the runner uses — so a
  // 5-agent run with a 7-role catalog only produces deliverables for
  // the first 5 roles, in agent order.
  const out: RoleDeliverable[] = [];
  for (let agentIndex = 1; agentIndex <= agentCount; agentIndex++) {
    const role = roleForAgent(agentIndex, roles);
    const body = lastByAgent.get(agentIndex) ?? "";
    out.push({
      roleName: role.name,
      agentIndex,
      body,
      produced: body.length > 0,
    });
  }
  return out;
}

/** Find the most recent role-diff synthesis bubble in the transcript.
 *  Identified by the `summary.kind === "role_diff_synthesis"` tag the
 *  runner stamps when synthesis succeeds. Returns the entry's text or
 *  null when no synthesis ran (e.g. the run user-stopped before the
 *  loop's final pass). */
export function findRoleDiffSynthesis(
  transcript: readonly TranscriptEntry[],
): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role !== "agent") continue;
    if (e.summary?.kind === "role_diff_synthesis") {
      return (e.text ?? "").trim() || null;
    }
  }
  return null;
}

/** Build the deliverable sections array for role-diff. Caller passes
 *  the result to writeDeliverable() / writeDeliverableAndEmit().
 *
 *  Section order:
 *    1. Directive (always — "Open analysis" placeholder when absent)
 *    2. Per-role deliverables (one per agent, in agent order)
 *    3. Synthesis (when present)
 *
 *  Pure — no LLM calls; the writer's quality-pass extras (rubric,
 *  critic, next-actions) are layered on top via runQualityPasses. */
export function buildRoleDiffDeliverableSections(input: {
  userDirective?: string;
  roles: readonly SwarmRole[];
  agentCount: number;
  transcript: readonly TranscriptEntry[];
}): DeliverableSection[] {
  const directive = (input.userDirective ?? "").trim();
  const sections: DeliverableSection[] = [];

  sections.push({
    title: "Directive",
    body: directive.length > 0 ? directive : "_(no directive — open repo analysis)_",
  });

  const perRole = collectRoleDeliverables(
    input.transcript,
    input.roles,
    input.agentCount,
  );
  for (const rd of perRole) {
    sections.push({
      title: `${rd.roleName} (Agent ${rd.agentIndex})`,
      body: rd.produced
        ? rd.body
        : `_(role did not produce a \`### MY DELIVERABLE\` block in this run)_`,
    });
  }

  const synthesis = findRoleDiffSynthesis(input.transcript);
  if (synthesis) {
    sections.push({
      title: "Synthesis",
      body: synthesis,
    });
  }

  return sections;
}
