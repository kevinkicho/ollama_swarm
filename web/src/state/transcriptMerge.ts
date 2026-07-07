import type { TranscriptEntry } from "../types";

export type StreamingMetaEntry = {
  startedAt: number;
  lastTextAt: number;
  status: "live" | "done";
  endedAt?: number;
};

/** Slice of store state that transcript append/hydrate mutates. */
export type TranscriptMergeSlice = {
  transcript: TranscriptEntry[];
  streaming: Record<string, string>;
  streamingMeta: Record<string, StreamingMetaEntry>;
};

const SEED_PREFIXES = [
  "Memory: surfaced",
  "Design memory: surfaced",
  "Seed: ",
  "Goal-generation pre-pass:",
] as const;

function runIdFromDividerText(text: string): string | undefined {
  return (text.match(/runId=([^|]+)/) ?? [])[1];
}

function moveDividerToFront(transcript: TranscriptEntry[]): TranscriptEntry[] {
  const dividerIdx = transcript.findIndex(
    (t) => t.role === "system" && t.text?.startsWith("▸▸RUN-START▸▸"),
  );
  if (dividerIdx > 0) {
    const div = transcript[dividerIdx]!;
    return [div, ...transcript.filter((_, i) => i !== dividerIdx)];
  }
  return transcript;
}

/**
 * Merge one transcript entry into a store slice. Returns null when the entry
 * is skipped (id dedup, RUN-START dedup, seed/skip/finished dedup, etc.).
 * Shared by appendEntry (WS) and hydrateTranscriptEntries (REST batch).
 */
export function mergeTranscriptEntry(
  slice: TranscriptMergeSlice,
  e: TranscriptEntry,
): TranscriptMergeSlice | null {
  if (slice.transcript.some((t) => t.id === e.id)) return null;

  if (e.role === "system" && e.text.startsWith("▸▸RUN-START▸▸")) {
    const incomingRunId = runIdFromDividerText(e.text);
    const already = slice.transcript.some(
      (t) =>
        t.role === "system" &&
        t.text.startsWith("▸▸RUN-START▸▸") &&
        runIdFromDividerText(t.text) === incomingRunId,
    );
    if (already) return null;
  }

  if (e.summary?.kind === "run_finished") {
    if (slice.transcript.some((t) => t.summary?.kind === "run_finished")) return null;
  }

  if (e.summary?.kind === "deliverable") {
    const fname = (e.summary as { filename?: string }).filename;
    if (
      slice.transcript.some((t) => {
        if (t.summary?.kind !== "deliverable") return false;
        if (fname && (t.summary as { filename?: string }).filename === fname) return true;
        return t.text.startsWith("Deliverable saved →");
      })
    ) {
      return null;
    }
  }

  if (e.role === "system") {
    for (const prefix of SEED_PREFIXES) {
      if (e.text.startsWith(prefix)) {
        const already = slice.transcript.some(
          (t) => t.role === "system" && t.text.startsWith(prefix),
        );
        if (already) return null;
        break;
      }
    }
  }

  if (e.summary?.kind === "worker_skip") {
    const skipReason = (e.summary as { reason?: string }).reason?.trim() || e.text?.trim() || "";
    if (skipReason) {
      const alreadySkip = slice.transcript.some(
        (t) =>
          t.summary?.kind === "worker_skip" &&
          ((t.summary as { reason?: string }).reason?.trim() || t.text?.trim() || "") === skipReason,
      );
      if (alreadySkip) return null;
    }
  }

  const nextStreaming = { ...slice.streaming };
  const nextMeta = { ...slice.streamingMeta };
  const entryToAdd = e;

  if (e.agentId) {
    const streamingText = nextStreaming[e.agentId];
    const meta = nextMeta[e.agentId];
    if (streamingText && streamingText.length > 0) {
      const streamEntry: TranscriptEntry = {
        id: `stream-${e.agentId}-${Date.now()}`,
        role: "agent-stream",
        text: streamingText,
        ts: meta?.startedAt ?? Date.now(),
        agentId: e.agentId,
        streamingMeta: {
          startedAt: meta?.startedAt ?? Date.now(),
          lastTextAt: meta?.lastTextAt ?? Date.now(),
          toolCallCount: 0,
          totalSeconds: meta ? Math.round((meta.lastTextAt - meta.startedAt) / 1000) : 0,
        },
      };
      delete nextStreaming[e.agentId];
      delete nextMeta[e.agentId];
      return {
        transcript: moveDividerToFront([...slice.transcript, streamEntry, entryToAdd]),
        streaming: nextStreaming,
        streamingMeta: nextMeta,
      };
    }
    delete nextStreaming[e.agentId];
    delete nextMeta[e.agentId];
  }

  let finalTranscript = moveDividerToFront([...slice.transcript, entryToAdd]);

  const result: TranscriptMergeSlice = {
    transcript: finalTranscript,
    streaming: nextStreaming,
    streamingMeta: nextMeta,
  };

  if (entryToAdd.summary?.kind === "run_finished") {
    result.streaming = {};
    result.streamingMeta = {};
  }

  return result;
}