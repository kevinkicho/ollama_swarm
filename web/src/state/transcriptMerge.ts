import { extractJsonFromText } from "@ollama-swarm/shared/extractJson";
import { extractThinkTags } from "@ollama-swarm/shared/extractThinkTags";
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

function canonicalAgentText(text: string): string {
  const trimmed = text.trim();
  const extracted = extractJsonFromText(trimmed);
  const candidate = extracted ?? trimmed;
  try {
    return JSON.stringify(JSON.parse(candidate));
  } catch {
    return trimmed;
  }
}

/** Stream buffer may still carry think tags; final transcript text does not. */
function streamVisibleText(streamed: string): string {
  return extractThinkTags(streamed).finalText.trim();
}

/** True when a flushed stream snapshot duplicates the final agent text. */
export function textsAreRedundantStream(streamed: string, final: string): boolean {
  const s = streamVisibleText(streamed);
  const f = final.trim();
  if (!s || !f) return false;
  if (s === f) return true;
  const cs = canonicalAgentText(s);
  const cf = canonicalAgentText(f);
  if (cs === cf) return true;
  if (cf.startsWith(cs) && cs.length >= 40) return true;
  if (f.startsWith(s) && s.length >= 40) return true;
  return false;
}

function pruneAgentStreamsForAgent(
  transcript: TranscriptEntry[],
  agentId: string,
  finalText: string,
): { transcript: TranscriptEntry[]; folded?: TranscriptEntry["streamSnapshot"] } {
  let folded: TranscriptEntry["streamSnapshot"] | undefined;
  const next = transcript.filter((t) => {
    if (t.role !== "agent-stream" || t.agentId !== agentId) return true;
    if (textsAreRedundantStream(t.text, finalText)) return false;
    if (!folded) {
      folded = {
        text: t.text,
        streamingMeta: t.streamingMeta,
      };
    }
    return false;
  });
  return { transcript: next, folded };
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
  let entryToAdd = e;

  let workingTranscript = slice.transcript;
  if (e.agentId && e.role === "agent") {
    const pruned = pruneAgentStreamsForAgent(workingTranscript, e.agentId, e.text ?? "");
    workingTranscript = pruned.transcript;
    if (pruned.folded && !entryToAdd.streamSnapshot) {
      entryToAdd = { ...entryToAdd, streamSnapshot: pruned.folded };
    }
  }

  if (e.agentId) {
    const streamingText = nextStreaming[e.agentId];
    const meta = nextMeta[e.agentId];
    if (streamingText && streamingText.length > 0) {
      const finalText = (e.text ?? "").trim();
      const isRedundantStream = finalText.length > 0 && textsAreRedundantStream(streamingText, finalText);

      if (!isRedundantStream && e.role === "agent") {
        const snapshot = {
          text: streamingText,
          streamingMeta: {
            startedAt: meta?.startedAt ?? Date.now(),
            lastTextAt: meta?.lastTextAt ?? Date.now(),
            toolCallCount: 0,
            totalSeconds: meta ? Math.round((meta.lastTextAt - meta.startedAt) / 1000) : 0,
          },
        };
        entryToAdd = {
          ...entryToAdd,
          streamSnapshot: entryToAdd.streamSnapshot ?? snapshot,
        };
      }
    }
    delete nextStreaming[e.agentId];
    delete nextMeta[e.agentId];
  }

  let finalTranscript = moveDividerToFront([...workingTranscript, entryToAdd]);

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