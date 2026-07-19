/**
 * Cap status JSON size for browser hydrate.
 *
 * Live: completed BB runs (72f72773 / 5a33a5f7) returned 5–6MB status payloads
 * (full transcript text) and made first paint feel frozen after recent long runs.
 */

import type { SwarmStatus, TranscriptEntry } from "../types.js";

/** Keep last N transcript bubbles on HTTP status (WS still streams live). */
export const STATUS_HTTP_TRANSCRIPT_TAIL = 80;
/** Soft cap per entry text (chars). */
export const STATUS_HTTP_ENTRY_TEXT_MAX = 6_000;
/** Absolute soft cap on total transcript chars in one status response. */
export const STATUS_HTTP_TRANSCRIPT_CHARS_MAX = 400_000;

export interface CompactStatusMeta {
  transcriptTruncated: boolean;
  transcriptTotal: number;
  transcriptReturned: number;
}

function trimEntry(e: TranscriptEntry, maxText: number): TranscriptEntry {
  const text = typeof e.text === "string" ? e.text : "";
  if (text.length <= maxText) return e;
  return {
    ...e,
    text:
      text.slice(0, maxText) +
      `\n…[truncated ${text.length - maxText} chars for hydrate speed]`,
  };
}

/**
 * Compact a SwarmStatus for HTTP GET /status and /runs/:id/status.
 * Does not mutate the live runner transcript.
 */
export function compactStatusForHttp(
  status: SwarmStatus,
  opts?: {
    tail?: number;
    entryTextMax?: number;
    totalCharsMax?: number;
  },
): SwarmStatus & { hydrate?: CompactStatusMeta } {
  const tail = opts?.tail ?? STATUS_HTTP_TRANSCRIPT_TAIL;
  const entryTextMax = opts?.entryTextMax ?? STATUS_HTTP_ENTRY_TEXT_MAX;
  const totalCharsMax = opts?.totalCharsMax ?? STATUS_HTTP_TRANSCRIPT_CHARS_MAX;

  const full = Array.isArray(status.transcript) ? status.transcript : [];
  const total = full.length;
  let slice = total > tail ? full.slice(-tail) : full.slice();
  let truncated = total > tail;

  // Cap individual texts
  slice = slice.map((e) => trimEntry(e, entryTextMax));

  // Enforce total char budget from the end (keep newest)
  let chars = 0;
  const kept: TranscriptEntry[] = [];
  for (let i = slice.length - 1; i >= 0; i--) {
    const e = slice[i]!;
    const len = (e.text ?? "").length;
    if (kept.length > 0 && chars + len > totalCharsMax) {
      truncated = true;
      break;
    }
    chars += len;
    kept.unshift(e);
  }

  // Also slim nested summary.transcript if present (history hydrate path).
  let summary = status.summary;
  if (summary && Array.isArray((summary as { transcript?: unknown }).transcript)) {
    const st = (summary as { transcript: TranscriptEntry[] }).transcript;
    const slim =
      st.length > tail
        ? st.slice(-tail).map((e) => trimEntry(e, entryTextMax))
        : st.map((e) => trimEntry(e, entryTextMax));
    if (slim.length !== st.length || slim.some((e, i) => e !== st[i])) {
      truncated = true;
      summary = { ...summary, transcript: slim } as typeof summary;
    }
  }

  return {
    ...status,
    transcript: kept,
    summary,
    hydrate: {
      transcriptTruncated: truncated || kept.length < total,
      transcriptTotal: total,
      transcriptReturned: kept.length,
    },
  };
}
