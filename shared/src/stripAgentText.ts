// Task #230: shared two-stage strip applied to every agent text BEFORE
// it lands in a TranscriptEntry. Mirrors what BlackboardRunner.appendAgent
// has done since 2026-04-27 evening (#229) but extracted so the other
// 6 runners (council, debate-judge, mapreduce, orchestrator-worker,
// orchestrator-worker-deep, role-diff, round-robin, stigmergy) can
// share it without duplicating the two extractor calls.
//
// Returns the post-strip finalText (what the bubble renders) plus the
// two extracted-out fields (thoughts + toolCalls). Runners spread these
// into their own TranscriptEntry shape:
//
//   const { finalText, thoughts, toolCalls } = stripAgentText(rawText);
//   const entry: TranscriptEntry = {
//     id: randomUUID(), role: "agent", agentId, agentIndex,
//     text: finalText || "(empty response)",
//     ts: Date.now(),
//     summary: ...,  // runner-specific
//     ...(thoughts.length > 0 ? { thoughts } : {}),
//     ...(toolCalls.length > 0 ? { toolCalls } : {}),
//   };

import { extractThinkTags } from "./extractThinkTags.js";
import { extractToolCallMarkers } from "./extractToolCallMarkers.js";

export interface StrippedAgentText {
  finalText: string;
  thoughts: string;
  toolCalls: string[];
}

// After stripping think tags and tool-call markers, the remaining text can
// be semantically empty even if it's not literally "". Common post-strip
// artifacts: "[]", "[]]", "{}", "  ", etc. — bracket/brace junk from a
// model that wrapped its entire response in tool calls or thinking tags.
// Treat these as empty so the bubble placeholder "(empty response)" kicks
// in instead of rendering raw brackets.
const SEMANTICALLY_EMPTY_RE = /^\s*[\[\]{}]+\s*$/;

export function stripAgentText(text: string): StrippedAgentText {
  const { thoughts: rawThoughts, finalText: postThink } = extractThinkTags(text);
  const fromBody = extractToolCallMarkers(postThink);
  const fromThoughts = rawThoughts
    ? extractToolCallMarkers(rawThoughts)
    : { toolCalls: [] as string[], finalText: "" };
  const rawFinal = fromBody.finalText;
  const finalText = SEMANTICALLY_EMPTY_RE.test(rawFinal) ? "" : rawFinal;
  const thoughts = fromThoughts.finalText.trim();
  const toolCalls = [...fromThoughts.toolCalls, ...fromBody.toolCalls];
  return { finalText, thoughts, toolCalls };
}

/** Text to feed JSON.parse / extractJsonFromText — strips thinking + pseudo-tool XML first. */
export function stripForJsonParse(raw: string): string {
  return stripAgentText(raw).finalText.trim();
}
