import type { TranscriptEntry } from "../types";
import { textsAreRedundantStream } from "./transcriptMerge.js";

/**
 * Hide agent-stream entries superseded by a later final agent bubble for the
 * same agent. Covers hydrated historical transcripts where merge-time folding
 * did not run.
 */
export function filterSupersededAgentStreams(transcript: TranscriptEntry[]): TranscriptEntry[] {
  const hideIds = new Set<string>();
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i]!;
    if (e.role !== "agent-stream" || !e.agentId) continue;
    for (let j = i + 1; j < transcript.length; j++) {
      const next = transcript[j]!;
      if (next.role !== "agent" || next.agentId !== e.agentId) continue;
      hideIds.add(e.id);
      break;
    }
  }
  if (hideIds.size === 0) return transcript;
  return transcript.filter((t) => !hideIds.has(t.id));
}

/** Fold streamSnapshot onto agent entries when replay/hydrate left them split. */
export function attachOrphanStreamSnapshots(transcript: TranscriptEntry[]): TranscriptEntry[] {
  const streamByAgent = new Map<string, TranscriptEntry>();
  for (const e of transcript) {
    if (e.role === "agent-stream" && e.agentId) {
      streamByAgent.set(e.agentId, e);
    }
  }
  if (streamByAgent.size === 0) return transcript;

  let changed = false;
  const enriched = transcript.map((e) => {
    if (e.role !== "agent" || !e.agentId || e.streamSnapshot) return e;
    const stream = streamByAgent.get(e.agentId);
    if (!stream) return e;
    const streamIdx = transcript.findIndex((t) => t.id === stream.id);
    const agentIdx = transcript.findIndex((t) => t.id === e.id);
    if (streamIdx < 0 || agentIdx < 0 || streamIdx >= agentIdx) return e;
    if (textsAreRedundantStream(stream.text, e.text)) return e;
    changed = true;
    return {
      ...e,
      streamSnapshot: {
        text: stream.text,
        streamingMeta: stream.streamingMeta,
      },
    };
  });
  return changed ? enriched : transcript;
}

export function prepareTranscriptForDisplay(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return filterSupersededAgentStreams(attachOrphanStreamSnapshots(transcript));
}