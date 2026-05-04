// Q6 (2026-05-04): dynamic role picker for round-robin / role-diff.
//
// Default behavior: roles cycle through a fixed catalog
// (Critic/Synthesizer/Gap-finder/Builder for round-robin;
// Researcher/Designer/Implementer/Tester/Reviewer/Documenter/
// Devil's-advocate for role-diff). The cycle is index-based +
// blind to what the conversation actually needs.
//
// This lever flips the next-role choice into a meta-prompt: a
// planner-tier model reads the recent transcript + the available
// role catalog + picks the role most likely to MOVE THE CONVERSATION
// FORWARD this turn. (E.g., if 3 prior turns were all "drafter"
// builders, the picker should suggest Critic; if a contradiction
// was just flagged, suggest Synthesizer to resolve it.)
//
// Pure prompt builder + parser. The runner's loop consults the
// picker between turns when cfg.dynamicRolePicker is set.
//
// Tradeoffs:
//   - One extra meta-prompt per turn (~1-2s + planner-tier cost).
//   - Picker can stall on safe choices (always picks Critic). The
//     prompt explicitly biases against repetition.
//   - When the meta-prompt fails to parse, the runner falls back to
//     the legacy fixed-cycle index.

export interface RoleOption {
  /** Role id used in the prompt (e.g., "critic"). Lowercase; no spaces. */
  id: string;
  /** Short human-readable label. */
  label: string;
  /** One-sentence description of what this role does. */
  description: string;
}

export interface DynamicRolePick {
  /** The picked role id (must be in the supplied roles array). */
  pickedId: string;
  /** Free-text rationale (one sentence). */
  rationale: string;
}

export function buildDynamicRolePickerPrompt(args: {
  /** Available role catalog. */
  roles: readonly RoleOption[];
  /** Recent transcript window — typically last 4-6 turns. */
  recentTurns: ReadonlyArray<{ role: string; text: string; agentIndex?: number }>;
  /** Optional user directive for context. */
  userDirective?: string;
  /** Roles used in the last N turns; the picker should AVOID these
   *  unless conversation demands it (anti-repetition bias). */
  recentlyUsedRoleIds: readonly string[];
}): string {
  const { roles, recentTurns, userDirective, recentlyUsedRoleIds } = args;
  const directiveBlock = userDirective?.trim()
    ? [`Directive: ${userDirective.trim()}`, ""]
    : [];
  const turnsBlock = recentTurns.map((t, i) => {
    const label =
      typeof t.agentIndex === "number" ? `Agent ${t.agentIndex}` : "Agent";
    return `[T-${recentTurns.length - i}] ${label} (${t.role}): ${t.text.trim().slice(0, 600)}`;
  });
  const recentRolesNote =
    recentlyUsedRoleIds.length > 0
      ? `Recently used (try to vary): ${recentlyUsedRoleIds.join(", ")}`
      : "";
  return [
    "You are picking the role for the NEXT speaker in a multi-agent conversation. Pick the role most likely to MOVE THE CONVERSATION FORWARD this turn — not the role that's just next in some rotation.",
    "",
    ...directiveBlock,
    "Available roles:",
    ...roles.map((r) => `  - ${r.id} (${r.label}): ${r.description}`),
    ...(recentRolesNote ? ["", recentRolesNote] : []),
    "",
    "Recent transcript:",
    ...turnsBlock,
    "",
    "Pick by what the conversation NEEDS now:",
    "- If 2+ recent turns agreed without challenge → pick a Critic-like role to surface dissent.",
    "- If contradictions were flagged but not resolved → pick a Synthesizer-like role.",
    "- If the conversation is stuck in abstraction → pick a Builder-like role to demand specifics.",
    "- If a gap was named but not investigated → pick a Gap-finder / Researcher to dig in.",
    "- Don't pick a role used in the last 1-2 turns unless the conversation REALLY demands it.",
    "",
    "Output STRICT JSON only — no prose, no fences:",
    `{"pickedId": "<one of: ${roles.map((r) => r.id).join(", ")}>", "rationale": "<one sentence why>"}`,
  ].join("\n");
}

/** Lenient parser. Returns null on parse failure or invalid id. Pure. */
export function parseDynamicRolePick(
  raw: string,
  validRoleIds: readonly string[],
): DynamicRolePick | null {
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
  const validSet = new Set(validRoleIds);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const id = parsed.pickedId;
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (!validSet.has(trimmed)) continue;
      const rationale =
        typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
      return { pickedId: trimmed, rationale };
    } catch {
      // try next candidate
    }
  }
  return null;
}
