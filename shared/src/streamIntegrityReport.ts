/**
 * Aggregate stream-integrity signals from a finished transcript.
 * Used by summary.json + history UI so operators can see loop/truncate
 * events without grepping multi-MB debug logs (run 9f449937 RCA).
 */

export interface StreamIntegrityEvent {
  agentId?: string;
  kind: string;
  detail: string;
  ts?: number;
}

export interface StreamIntegrityReport {
  /** How many [stream-integrity] system lines were emitted. */
  anomalyEventCount: number;
  /** Distinct agents that triggered integrity handling. */
  agentsAffected: string[];
  /** Max agent bubble text length observed in transcript. */
  maxAgentTextChars: number;
  /** Max agent thoughts length observed. */
  maxAgentThoughtChars: number;
  /** Parsed anomaly events (capped). */
  events: StreamIntegrityEvent[];
  /** True if any phrase-loop collapse was recorded. */
  hadLoopCollapse: boolean;
  /** True if any hard-truncate of final/thoughts was recorded. */
  hadHardTruncate: boolean;
}

// Accept both legacy [stream-integrity] and new [transcript-cap] prefixes.
const STREAM_INTEGRITY_RE = /^\[(?:stream-integrity|transcript-cap)\]\s+(\S+):\s+(.+)$/i;
const MAX_EVENTS = 40;

export type TranscriptLike = {
  role?: string;
  text?: string;
  thoughts?: string;
  agentId?: string;
  ts?: number;
};

/**
 * Scan transcript for stream-integrity system lines + peak agent sizes.
 */
export function collectStreamIntegrityReport(
  transcript: readonly TranscriptLike[] | undefined | null,
): StreamIntegrityReport | undefined {
  if (!transcript || transcript.length === 0) return undefined;

  const events: StreamIntegrityEvent[] = [];
  const agents = new Set<string>();
  let maxAgentTextChars = 0;
  let maxAgentThoughtChars = 0;
  let hadLoopCollapse = false;
  let hadHardTruncate = false;

  for (const e of transcript) {
    if (e.role === "agent") {
      const tLen = (e.text ?? "").length;
      const thLen = (e.thoughts ?? "").length;
      if (tLen > maxAgentTextChars) maxAgentTextChars = tLen;
      if (thLen > maxAgentThoughtChars) maxAgentThoughtChars = thLen;
    }
    if (e.role === "system" && typeof e.text === "string") {
      const m = STREAM_INTEGRITY_RE.exec(e.text.trim());
      if (!m) continue;
      const agentId = m[1];
      const detail = m[2] ?? "";
      agents.add(agentId);
      if (/collapsed|loop/i.test(detail)) hadLoopCollapse = true;
      if (/hard-truncated|storage-capped|truncated/i.test(detail)) hadHardTruncate = true;
      if (events.length < MAX_EVENTS) {
        const isLoop = /loop|collapsed/i.test(detail);
        events.push({
          agentId,
          kind: isLoop ? "loop" : /storage-capped|hard-truncated|truncated/i.test(detail) ? "storage_cap" : "integrity",
          detail: detail.slice(0, 400),
          ts: e.ts,
        });
      }
    }
  }

  if (
    events.length === 0
    && maxAgentTextChars < 48_000
    && maxAgentThoughtChars < 24_000
  ) {
    return undefined;
  }

  return {
    anomalyEventCount: events.length,
    agentsAffected: [...agents],
    maxAgentTextChars,
    maxAgentThoughtChars,
    events,
    hadLoopCollapse,
    hadHardTruncate,
  };
}
