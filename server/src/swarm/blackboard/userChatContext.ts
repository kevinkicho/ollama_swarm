import type { TranscriptEntry } from "../../types.js";
import { userEntryVisibleTo } from "../chatReceipt.js";

export type UserChatIntent = "suggest" | "steer" | "ask";

export interface UserChatEntry {
  text: string;
  intent: UserChatIntent;
  ts: number;
}

export function normalizeUserChatIntent(
  intent: TranscriptEntry["intent"] | undefined,
): UserChatIntent {
  if (intent === "suggest" || intent === "ask") return intent;
  return "steer";
}

/** Collect user-role transcript entries visible to a given agent (@mention routing). */
export function collectUserChatEntries(
  transcript: readonly TranscriptEntry[],
  forAgentId: string,
): UserChatEntry[] {
  return transcript
    .filter((e) => e.role === "user" && userEntryVisibleTo(e, forAgentId))
    .map((e) => ({
      text: (e.text ?? "").trim(),
      intent: normalizeUserChatIntent(e.intent),
      ts: e.ts,
    }))
    .filter((e) => e.text.length > 0);
}

/**
 * Render mid-run user chat for blackboard prompts.
 * Steer messages are normally carried via directiveWithAmendments — exclude
 * them here by default to avoid double-feeding.
 */
export function formatUserChatBlock(
  entries: readonly UserChatEntry[],
  opts?: { excludeSteer?: boolean },
): string | undefined {
  const excludeSteer = opts?.excludeSteer !== false;
  const filtered = excludeSteer
    ? entries.filter((e) => e.intent !== "steer")
    : [...entries];
  if (filtered.length === 0) return undefined;

  const lines = filtered.map((e) => {
    const stamp = new Date(e.ts).toISOString();
    switch (e.intent) {
      case "suggest":
        return (
          `[USER SUGGESTION @ ${stamp}] ${e.text}\n` +
          "  → Low-pressure: consider only if relevant to this turn. Do NOT reshape the contract or todo list solely because of this."
        );
      case "ask":
        return (
          `[USER QUESTION @ ${stamp}] ${e.text}\n` +
          "  → Answer briefly inline if you can, then continue your primary task. Do NOT change direction or scope because of this question."
        );
      case "steer":
        return (
          `[USER STEER @ ${stamp}] ${e.text}\n` +
          "  → Treat as an addition to the directive."
        );
    }
  });

  return [
    "=== USER CHAT (mid-run messages from the human operator) ===",
    ...lines,
    "=== end USER CHAT ===",
  ].join("\n");
}