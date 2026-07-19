import type { TranscriptEntry } from "../types";
import { textsAreRedundantStream } from "./transcriptMerge.js";

/**
 * Hide agent-stream entries superseded by a later final agent bubble for the
 * same agent. Covers hydrated historical transcripts where merge-time folding
 * did not run.
 *
 * O(n) — prior nested scan was O(n²) and froze the UI on multi-hour runs
 * (10k–30k transcript entries).
 */
export function filterSupersededAgentStreams(transcript: TranscriptEntry[]): TranscriptEntry[] {
  if (transcript.length === 0) return transcript;

  // Last index of a final agent bubble per agentId.
  const lastFinalIdx = new Map<string, number>();
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i]!;
    if (e.role === "agent" && e.agentId) lastFinalIdx.set(e.agentId, i);
  }
  if (lastFinalIdx.size === 0) return transcript;

  const hideIds = new Set<string>();
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i]!;
    if (e.role !== "agent-stream" || !e.agentId) continue;
    const fi = lastFinalIdx.get(e.agentId);
    if (fi != null && fi > i) hideIds.add(e.id);
  }
  if (hideIds.size === 0) return transcript;
  return transcript.filter((t) => !hideIds.has(t.id));
}

/** Fold streamSnapshot onto agent entries when replay/hydrate left them split. O(n). */
export function attachOrphanStreamSnapshots(transcript: TranscriptEntry[]): TranscriptEntry[] {
  if (transcript.length === 0) return transcript;

  // Last agent-stream entry per agent (by array order).
  const streamByAgent = new Map<string, TranscriptEntry>();
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i]!;
    idToIndex.set(e.id, i);
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
    const streamIdx = idToIndex.get(stream.id);
    const agentIdx = idToIndex.get(e.id);
    if (streamIdx == null || agentIdx == null || streamIdx >= agentIdx) return e;
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
  // Attach first so we can fold stream text onto the final bubble, then hide
  // the raw agent-stream rows.
  return filterSupersededAgentStreams(attachOrphanStreamSnapshots(transcript));
}
