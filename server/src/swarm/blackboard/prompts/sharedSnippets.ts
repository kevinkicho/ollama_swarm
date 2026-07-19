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

/**
 * Host-aware tooling constraints. Injected into tool-using roles so Windows
 * agents stop burning turns on `wc`/`grep` via bash.
 */
export function hostToolingConstraintLines(): readonly string[] {
  if (process.platform === "win32") {
    return [
      "HOST=Windows: never use bash for Unix utilities (wc, grep, cat, find, head, tail, ls, sed, awk).",
      "Use built-in read/grep/glob/list for inspection; write/edit tools for changes; finish with workingTree or small hunk JSON.",
    ];
  }
  return [
    "Prefer built-in read/grep/glob/list over shell one-liners when inspecting the repo.",
  ];
}

/** Short tools preamble for roles that may call read/grep/glob/list mid-turn. */
export function buildRepoToolsNote(extraLines: readonly string[] = []): string {
  return [
    "=== TOOLS ===",
    "read, grep, glob, list (and others when enabled). Use tools for evidence; final reply is still the role's JSON.",
    ...hostToolingConstraintLines(),
    ...extraLines,
    "=== end TOOLS ===",
  ].join("\n");
}

/**
 * Static note for planner/auditor hierarchy: peer tool contests.
 * Live open-contest lists are injected per-prompt via toolContest.withOpenContestsPromptContext.
 */
export const TOOL_CONTEST_HIERARCHY_NOTE = [
  "Tool contests: workers may be denied by profile (not path sandbox).",
  "If OPEN TOOL CONTESTS lists peer denials, you may one-shot approve|deny with:",
  '{"resolveContest":true,"contestId":"<id>","approve":true,"reason":"..."}',
  "Never self-approve your own denial. Prefer approve only for durable progress; deny bash thrash.",
].join("\n");

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
