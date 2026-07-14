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

export function resolveMentionTarget(
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

function resolveTarget(
  to: string,
  resolveRole: ((role: string) => number | null) | undefined,
): number | null {
  return resolveMentionTarget(to, resolveRole);
}

export type PendingMention = MentionContract & { emittedTs: number };

/**
 * Collect unaddressed mention contracts targeted at `agentIndex` from the
 * transcript. Used when cfg.mentionContracts is on.
 */
export function collectPendingMentionsForAgent(args: {
  transcript: readonly TranscriptEntry[];
  agentIndex: number;
  resolveRole?: (role: string) => number | null;
}): PendingMention[] {
  const { transcript, agentIndex, resolveRole } = args;
  const pending: PendingMention[] = [];

  for (const e of transcript) {
    if (e.role !== "agent" || typeof e.agentIndex !== "number") continue;
    const text = e.text ?? "";
    for (const m of parseMentionContracts(text)) {
      const target = resolveMentionTarget(m.to, resolveRole);
      if (target !== agentIndex) continue;
      pending.push({
        ...m,
        fromAgentIndex: e.agentIndex,
        emittedTs: e.ts,
      });
    }
  }

  return pending.filter(
    (m) =>
      !isMentionAddressed({
        mention: m,
        laterEntries: transcript,
        resolveRole,
      }),
  );
}

/** Short instruction block so agents learn the envelope when the feature is on. */
export function buildMentionContractsInstructionBlock(): string {
  return [
    "=== @-mention contracts (optional) ===",
    "To assign a concrete ask to another agent, emit a fenced block:",
    "```mention",
    "to: agent-2   # or planner | auditor | judge | agent-N",
    "ask: <one sentence>",
    "why: <optional>",
    "urgency: should-do | nice-to-have | blocker",
    "```",
    "The target agent will see pending asks in their next prompt.",
    "=== end mention contracts ===",
  ].join("\n");
}

/**
 * Prepend pending mentions (+ instruction) to a discussion prompt.
 * Empty pending still includes the instruction when `includeInstruction` is true.
 */
export function injectMentionContractsIntoPrompt(args: {
  prompt: string;
  pending: readonly MentionContract[];
  includeInstruction?: boolean;
}): string {
  const parts: string[] = [];
  if (args.includeInstruction !== false) {
    parts.push(buildMentionContractsInstructionBlock());
    parts.push("");
  }
  const block = buildPendingMentionsBlock(args.pending);
  if (block) {
    parts.push(block);
    parts.push("");
  }
  if (parts.length === 0) return args.prompt;
  parts.push(args.prompt);
  return parts.join("\n");
}

/** Default role → index map for discussion swarms (best-effort). */
export function defaultDiscussionRoleResolver(
  agents: ReadonlyArray<{ index: number; id?: string }>,
): (role: string) => number | null {
  const byIndex = new Map(agents.map((a) => [a.index, a.index]));
  const first = agents.reduce(
    (min, a) => (a.index < min ? a.index : min),
    agents[0]?.index ?? 1,
  );
  return (role: string) => {
    const r = role.toLowerCase().trim();
    if (r === "planner" || r === "lead" || r === "synthesizer" || r === "brain") {
      return byIndex.get(first) ?? first;
    }
    if (r === "auditor" || r === "judge") {
      const max = Math.max(...agents.map((a) => a.index));
      return byIndex.get(max) ?? max;
    }
    const m = /^agent-?(\d+)$/i.exec(r);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      return byIndex.has(n) ? n : null;
    }
    return null;
  };
}
