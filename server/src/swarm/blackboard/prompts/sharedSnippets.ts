// Shared prompt fragments for structured roles (blackboard + judges).
// Prefer importing these over re-stating "JSON only / no fences / no XML"
// so wording does not drift across SYSTEM_PROMPT constants.
//
// Fence policy (see prompts/README.md):
//   - Structured swarm roles (final model answer): NO markdown fences.
//   - Brain config UX may intentionally use ```json for pasteable config.
//   - Freeform discussion may use ```mention envelopes (agentMentionContract).

/** HARD RULE lines for SYSTEM_PROMPT string arrays (single source of truth). */
export const JSON_ONLY_FINAL_RULE_LINES: readonly string[] = [
  "Final visible response: valid JSON only — no prose, no markdown fences.",
  "Do not emit raw XML tool-call tags as the reply; call tools via the SDK, then output JSON.",
];

/** Same contract as a single joined string (discussion builders, etc.). */
export const JSON_ONLY_FINAL_RULES = JSON_ONLY_FINAL_RULE_LINES.join("\n");

/** Compact JSON-array final-answer line used by council extractors. */
export const JSON_ARRAY_ONLY_LINE =
  "Return ONLY a JSON array — no markdown, no prose.";

/** Short tools preamble for roles that may call read/grep/glob/list mid-turn. */
export function buildRepoToolsNote(extraLines: readonly string[] = []): string {
  return [
    "=== TOOLS ===",
    "read, grep, glob, list (and others when enabled). Use tools for evidence; final reply is still the role's JSON.",
    ...extraLines,
    "=== end TOOLS ===",
  ].join("\n");
}

/**
 * Mention-contract policy for freeform (non-JSON-final) agents only.
 * Do NOT inject into planner/worker/auditor/critic/verifier system prompts.
 */
export const MENTION_CONTRACT_NOTE = [
  "Optional freeform mention envelope:",
  "```mention",
  "to: planner|auditor|judge|agent-N",
  "ask: <one sentence>",
  "why: <optional>",
  "urgency: blocker|should-do|nice-to-have",
  "```",
  "JSON-only roles: use todos/verdicts instead of mention fences.",
].join("\n");
