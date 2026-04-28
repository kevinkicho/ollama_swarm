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

export function stripAgentText(text: string): StrippedAgentText {
  const { thoughts, finalText: postThink } = extractThinkTags(text);
  const { toolCalls, finalText } = extractToolCallMarkers(postThink);
  return { finalText, thoughts, toolCalls };
}
