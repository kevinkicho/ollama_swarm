import { resolveBrainAgentId } from "@ollama-swarm/shared/brainAlias";

// Q3 (2026-05-04): inter-agent @-mention contracts.
//
// Agents can already write `@planner` / `@auditor` / `@agent-2` in
// their freeform output (chat-style mentions). This module promotes
// that informal pattern to a STRUCTURED envelope so the runner can
// route the ask + the receiving agent sees a clear contract instead
// of having to parse prose.
//
// Envelope shape (emitted by the SENDING agent):
//
//   ```mention
//   to: planner
//   ask: this hunk needs a paired test todo for src/foo.test.ts
//   why: the apply landed but verify says no test exercises the new branch
//   urgency: should-do | nice-to-have | blocker
//   ```
//
// The runner extracts these from the agent's transcript entry, attaches
// them to the entry as `mentions[]` metadata, and surfaces them in the
// receiving agent's next prompt as a "Pending @-mention contracts you
// have to address" block.
//
// Tradeoffs:
//   - Risks loop expansion: A asks B, B asks A back, repeat. Mitigated
//     by per-pair cooldown (track recent mention pairs; ignore a
//     re-mention within MENTION_COOLDOWN_TURNS turns of the same pair).
//   - Strict-format prompt cost: agents now have to learn an extra
//     output shape. The fence-block format is forgiving — anything
//     not matching is silently ignored, falling back to freeform.

import type { TranscriptEntry } from "../types.js";

export type MentionUrgency = "blocker" | "should-do" | "nice-to-have";

export interface MentionContract {
  /** Target agent: a role label ("planner", "auditor", "judge") OR
   *  an explicit agent index ("agent-2"). The receiving runner
   *  resolves to a concrete agent by name first, then index. */
  to: string;
  /** The concrete ask, one sentence. */
  ask: string;
  /** Optional rationale. Empty string when not provided. */
  why: string;
  /** Defaults to "should-do" when missing or unrecognized. */
  urgency: MentionUrgency;
  /** Source agent that emitted the mention (filled by the runner
   *  when attaching to a transcript entry). */
  fromAgentIndex?: number;
}

/** Inter-mention cooldown — how many turns a (from, to) pair waits
 *  before being eligible to re-mention. Prevents A→B→A→B loops. */
export const MENTION_COOLDOWN_TURNS = 3;

const MENTION_FENCE_RE = /```mention\s*\n([\s\S]*?)\n```/g;

/** Pure parser. Returns every mention envelope found in `text`.
 *  Forgiving: malformed envelopes (missing `to:` or `ask:`) are
 *  silently skipped. The fence MUST be triple-backtick + literal
 *  `mention` to count. */
export function parseMentionContracts(text: string): MentionContract[] {
  const out: MentionContract[] = [];
  for (const match of text.matchAll(MENTION_FENCE_RE)) {
    const body = match[1];
    const fields = parseFields(body);
    const to = fields.to?.trim() ?? "";
    const ask = fields.ask?.trim() ?? "";
    if (!to || !ask) continue;
    const why = fields.why?.trim() ?? "";
    const urgencyRaw = (fields.urgency ?? "should-do").trim();
    const urgency: MentionUrgency =
      urgencyRaw === "blocker" || urgencyRaw === "nice-to-have"
        ? urgencyRaw
        : "should-do";
    out.push({ to, ask, why, urgency });
  }
  return out;
}

function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/** Build the receiving-agent's "pending mentions" prompt block. The
 *  runner calls this with the mentions targeted at THIS agent that
 *  haven't been addressed yet. Empty array → empty string. */
export function buildPendingMentionsBlock(
  mentions: readonly MentionContract[],
): string {
  if (mentions.length === 0) return "";
  const lines: string[] = [
    "=== Pending @-mention contracts you have to address ===",
    "Other agents flagged concrete asks of you. Address each in your response — either action it, or explicitly explain why you're declining.",
    "",
  ];
  for (const m of mentions) {
    const fromLabel =
      typeof m.fromAgentIndex === "number"
        ? `Agent ${m.fromAgentIndex}`
        : "An agent";
    lines.push(`  [${m.urgency.toUpperCase()}] from ${fromLabel}:`);
    lines.push(`    ASK: ${m.ask}`);
    if (m.why) lines.push(`    WHY: ${m.why}`);
    lines.push("");
  }
  lines.push("=== End pending mentions ===");
  return lines.join("\n");
}

/** Cooldown gate. Returns the subset of mentions that should be
 *  surfaced this turn (i.e., the (from, to) pair hasn't been used
 *  in the last MENTION_COOLDOWN_TURNS turns).
 *
 *  `recentPairs` is a list of (fromIndex, toLabel) pairs from the
 *  most recent N turns; pure helper, no state of its own. */
export function filterMentionsByCooldown(
  mentions: readonly MentionContract[],
  recentPairs: ReadonlyArray<{ fromIndex: number; to: string }>,
  cooldownTurns: number = MENTION_COOLDOWN_TURNS,
): MentionContract[] {
  // Use the most-recent N pairs to count repetitions. A pair
  // appearing in the window blocks new mentions in the same direction.
  const window = recentPairs.slice(-cooldownTurns);
  const blocked = new Set<string>();
  for (const p of window) blocked.add(`${p.fromIndex}::${p.to.toLowerCase()}`);
  return mentions.filter((m) => {
    if (typeof m.fromAgentIndex !== "number") return true;
    return !blocked.has(`${m.fromAgentIndex}::${m.to.toLowerCase()}`);
  });
}

/** Heuristic: which transcript entry should "consume" a mention?
 *  A mention is considered ADDRESSED when an agent matching the
 *  `to` field (by index or role label) has spoken AFTER the
 *  mention was emitted. Pure — exported for tests; the runner
 *  uses it to drop already-addressed mentions from prompt blocks. */
export function isMentionAddressed(args: {
  mention: MentionContract & { emittedTs: number };
  /** The transcript window to search for an addressing turn. */
  laterEntries: readonly TranscriptEntry[];
  /** Optional resolver mapping role label → agent index. The runner
   *  threads this from its agent roster. */
  resolveRole?: (role: string) => number | null;
}): boolean {
  const { mention, laterEntries, resolveRole } = args;
  const targetIndex = resolveTarget(mention.to, resolveRole);
  for (const e of laterEntries) {
    if (e.role !== "agent") continue;
    if (e.ts <= mention.emittedTs) continue;
    if (typeof e.agentIndex !== "number") continue;
    if (targetIndex === null) continue;
    if (e.agentIndex === targetIndex) return true;
  }
  return false;
}

function resolveTarget(
  to: string,
  resolveRole: ((role: string) => number | null) | undefined,
): number | null {
  const toNorm = resolveBrainAgentId(to);
  // Explicit agent-N form
  const idxMatch = /^agent-(\d+)$/i.exec(toNorm);
  if (idxMatch) {
    const n = Number.parseInt(idxMatch[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  // Role label
  if (resolveRole) return resolveRole(toNorm.toLowerCase());
  return null;
}
