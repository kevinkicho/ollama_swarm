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
  "Output ONLY valid JSON as your FINAL visible response. No prose. No markdown fences. No commentary before or after.",
  "Do NOT emit raw XML tool-call syntax (e.g. `<read path='...' />` or `<grep pattern='...' />`) AS the response — that is the SDK's internal tool-call format and parsing it as JSON fails closed. Use the actual tool functions; the SDK invokes them transparently. Visible response MUST be only the JSON.",
];

/** Same contract as a single joined string (discussion builders, etc.). */
export const JSON_ONLY_FINAL_RULES = JSON_ONLY_FINAL_RULE_LINES.join("\n");

/** Compact JSON-array final-answer line used by council extractors. */
export const JSON_ARRAY_ONLY_LINE =
  "Return ONLY a JSON array. No markdown, no code fences, no explanation.";

/** Short tools preamble for roles that may call read/grep/glob/list mid-turn. */
export function buildRepoToolsNote(extraLines: readonly string[] = []): string {
  return [
    "=== AVAILABLE TOOLS ===",
    "You have read, grep, glob, and list on the cloned repo (plus other tools when the runner enabled them).",
    "Use tools to gather evidence; your FINAL visible response must still be the structured JSON this role requires.",
    ...extraLines,
    "=== end TOOLS NOTE ===",
  ].join("\n");
}

/**
 * Mention-contract policy for freeform (non-JSON-final) agents only.
 * Do NOT inject into planner/worker/auditor/critic/verifier system prompts.
 */
export const MENTION_CONTRACT_NOTE = [
  "Optional inter-agent ask (freeform roles only): you may emit a fenced mention envelope:",
  "```mention",
  "to: planner|auditor|judge|agent-N",
  "ask: <one sentence>",
  "why: <optional>",
  "urgency: blocker|should-do|nice-to-have",
  "```",
  "JSON-only roles must NOT use mention fences — route work through todos / verdicts / structured fields instead.",
].join("\n");
