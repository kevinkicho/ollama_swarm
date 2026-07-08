// 2026-05-02 (lever #1): synthetic system message that confirms a
// /api/swarm/say injection landed AND explains how it will affect the
// run. Pure-text — no LLM call, no token cost. Closes the "did anyone
// hear me" gap that existed when chat went straight to transcript with
// no acknowledgment.
//
// Wired by each runner's injectUser. The text is intentionally calm
// + factual so it reads as feedback, not noise.

import { resolveBrainAgentId } from "@ollama-swarm/shared/brainAlias";

export type ChatIntent = "suggest" | "steer" | "ask";

/** Minimal shape of a transcript user-entry — just what's needed for
 *  the visibility check. Avoids a wider TranscriptEntry import here so
 *  this module stays dependency-light. */
export interface UserEntryView {
  role: "user" | string;
  targetAgent?: string;
}

/** @mention routing visibility check.
 *
 *  Returns true when `entry` should be visible to `currentAgentId`.
 *  Rule:
 *    - Non-user entries are always visible (only user entries carry
 *      targetAgent metadata).
 *    - User entries with no targetAgent are broadcast — visible to all.
 *    - User entries with targetAgent === currentAgentId are targeted —
 *      visible only to that agent.
 *    - User entries with targetAgent !== currentAgentId are hidden from
 *      this agent (someone else was @mentioned).
 *
 *  This is the gate that lets the user surgically address one agent
 *  without polluting every other agent's context. Pure — tested in
 *  isolation. */
export function userEntryVisibleTo(entry: UserEntryView, currentAgentId: string): boolean {
  if (entry.role !== "user") return true;
  if (!entry.targetAgent) return true;
  return resolveBrainAgentId(entry.targetAgent) === resolveBrainAgentId(currentAgentId);
}

/** Build a one-line system receipt for a user chat injection.
 *  Intent-aware: each tag has a different downstream mechanism, and
 *  the receipt names that mechanism so the user can predict the
 *  impact. Pure — tested in isolation. */
export function formatChatReceipt(intent: ChatIntent, targetAgent?: string): string {
  const target = targetAgent ? ` to ${targetAgent}` : "";
  switch (intent) {
    case "suggest":
      // Low-pressure: visible to all agents next turn but doesn't change
      // the directive. Planner-tier prompts won't reshape around this.
      return `[chat receipt] Suggestion${target} queued — agents will see it on the next turn but won't change direction unless they choose to.`;
    case "ask":
      // Question: the runner doesn't change direction; the next agent
      // turn answers inline. For broadcast (no targetAgent), whichever
      // agent fires next picks it up.
      return `[chat receipt] Question${target} queued — the next agent turn will answer inline; direction unchanged.`;
    case "steer":
    default:
      // Default = current behavior. Active reshape of the next planner
      // turn (blackboard amendments buffer); broadcast to all discussion
      // runners' [HUMAN] formatter.
      return `[chat receipt] Steering nudge${target} queued — planner-tier prompts will treat this as an addition to the directive on the next turn.`;
  }
}
