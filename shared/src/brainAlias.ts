/** Canonical Brain agent id and user-facing alias ("Brian"). */

export const BRAIN_AGENT_ID = "brain";

/** Alternate names users may use for the Brain agent. */
export const BRAIN_ALIAS_NAMES = ["brian"] as const;

const BRAIN_ALIAS_SET = new Set<string>([BRAIN_AGENT_ID, ...BRAIN_ALIAS_NAMES]);

/** True when `name` refers to the Brain agent (canonical id or alias). */
export function isBrainAgentName(name: string): boolean {
  return BRAIN_ALIAS_SET.has(name.trim().toLowerCase());
}

/** Map Brain aliases to the canonical agent id; other ids pass through trimmed. */
export function resolveBrainAgentId(name: string): string {
  const trimmed = name.trim();
  if (isBrainAgentName(trimmed)) return BRAIN_AGENT_ID;
  return trimmed;
}

/** True when freeform text mentions Brain or its alias as a word. */
export function textMentionsBrainAlias(text: string): boolean {
  return /\b(brain|brian)\b/i.test(text);
}

/** System-prompt note so Brain accepts the "Brian" alias in chat. */
export const BRAIN_ALIAS_USER_NOTE =
  'Users may call you "Brian" — that is an intentional alias for Brain. Respond naturally either way.';