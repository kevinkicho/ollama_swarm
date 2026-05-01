// #90 (2026-05-01): time-travel replay reducer + hook.
//
// Given a runId, fetch /api/v2/event-log/runs/:runId once, then let the
// caller scrub backwards/forwards through the records. The hook's
// reducer folds records[0..currentIndex] into a state snapshot that
// mirrors the most-impactful subset of what the live WebSocket
// dispatch produces. Lighter than full WS-dispatch coverage — this is
// a debug/inspection tool, not a live-state replacement.
//
// Five events covered today (the smallest subset that produces a
// useful "what did the run look like at tick N" view):
//   - run_started        → sets runId / preset / model / startedAt
//   - swarm_state        → sets phase
//   - transcript_append  → appends to transcript
//   - agent_state        → upserts agent record
//   - run_summary        → marks terminal state, stores summary
//
// All other event types (todo_*, conformance_*, etc.) are read but not
// folded into the snapshot today. Adding them is mechanical when the
// next slice of the time-travel UI needs them.

import { useEffect, useState, useMemo } from "react";

export interface ReplayRecord {
  ts: number;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export interface ReplayAgentSnapshot {
  id: string;
  index?: number;
  status?: string;
  port?: number;
  sessionId?: string;
  model?: string;
}

export interface ReplaySnapshot {
  runId: string | null;
  preset: string | null;
  model: string | null;
  phase: string;
  startedAt: number | null;
  finishedAt: number | null;
  transcript: ReadonlyArray<{ id: string; role: string; text: string; ts: number; agentId?: string; agentIndex?: number }>;
  agents: ReadonlyArray<ReplayAgentSnapshot>;
  hasSummary: boolean;
}

export interface ReplayResponse {
  runId: string;
  derived: {
    runId?: string;
    preset?: string;
    finalPhase?: string;
    hasSummary: boolean;
  };
  records: ReplayRecord[];
  isSessionBoundary: boolean;
}

const EMPTY_SNAPSHOT: ReplaySnapshot = {
  runId: null,
  preset: null,
  model: null,
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  transcript: [],
  agents: [],
  hasSummary: false,
};

/** Pure reducer — fold records[0..n] into a single snapshot.
 *  Exported for unit tests. */
export function reduceToSnapshot(records: ReadonlyArray<ReplayRecord>): ReplaySnapshot {
  const snap: ReplaySnapshot = {
    ...EMPTY_SNAPSHOT,
    transcript: [],
    agents: [],
  };
  // Mutating local copies for accumulation; freeze before return.
  const transcript: Array<ReplaySnapshot["transcript"][number]> = [];
  const agents: Map<string, ReplayAgentSnapshot> = new Map();

  for (const record of records) {
    const ev = record.event;
    switch (ev.type) {
      case "run_started":
        if (typeof ev.runId === "string") snap.runId = ev.runId;
        if (typeof ev.preset === "string") snap.preset = ev.preset;
        if (typeof ev.plannerModel === "string") snap.model = ev.plannerModel;
        else if (typeof ev.model === "string") snap.model = ev.model;
        snap.startedAt = record.ts;
        break;
      case "swarm_state":
        if (typeof ev.phase === "string") snap.phase = ev.phase;
        break;
      case "transcript_append":
        if (ev.entry && typeof ev.entry === "object") {
          const e = ev.entry as Record<string, unknown>;
          if (typeof e.id === "string" && typeof e.role === "string") {
            transcript.push({
              id: e.id,
              role: e.role,
              text: typeof e.text === "string" ? e.text : "",
              ts: typeof e.ts === "number" ? e.ts : record.ts,
              ...(typeof e.agentId === "string" ? { agentId: e.agentId } : {}),
              ...(typeof e.agentIndex === "number" ? { agentIndex: e.agentIndex } : {}),
            });
          }
        }
        break;
      case "agent_state":
        if (typeof ev.id === "string") {
          const prior = agents.get(ev.id) ?? { id: ev.id };
          agents.set(ev.id, {
            ...prior,
            ...(typeof ev.index === "number" ? { index: ev.index } : {}),
            ...(typeof ev.status === "string" ? { status: ev.status } : {}),
            ...(typeof ev.port === "number" ? { port: ev.port } : {}),
            ...(typeof ev.sessionId === "string" ? { sessionId: ev.sessionId } : {}),
            ...(typeof ev.model === "string" ? { model: ev.model } : {}),
          });
        }
        break;
      case "run_summary":
        snap.hasSummary = true;
        snap.finishedAt = record.ts;
        break;
      default:
        // Unknown / unhandled event type — silently skip. The reader
        // is forward-compatible by design; new event kinds get folded
        // in as the UI needs them.
        break;
    }
  }

  return {
    ...snap,
    transcript: Object.freeze(transcript),
    agents: Object.freeze([...agents.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))),
  };
}

export interface UseReplayStateResult {
  loading: boolean;
  error: string | null;
  totalRecords: number;
  /** Current index into the records array (0..totalRecords). */
  cursor: number;
  setCursor: (n: number) => void;
  /** Snapshot folded from records[0..cursor]. */
  snapshot: ReplaySnapshot;
  /** Raw records for advanced UI (timeline density visualization, etc.). */
  records: ReadonlyArray<ReplayRecord>;
}

export function useReplayState(runId: string | null): UseReplayStateResult {
  const [response, setResponse] = useState<ReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!runId) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v2/event-log/runs/${encodeURIComponent(runId)}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setError(`HTTP ${r.status}`);
          setResponse(null);
          setLoading(false);
          return;
        }
        const body = (await r.json()) as ReplayResponse;
        setResponse(body);
        setCursor(body.records?.length ?? 0); // start at end (full state)
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const records = response?.records ?? [];
  const totalRecords = records.length;
  const safeCursor = Math.max(0, Math.min(totalRecords, cursor));

  const snapshot = useMemo(
    () => reduceToSnapshot(records.slice(0, safeCursor)),
    [records, safeCursor],
  );

  return {
    loading,
    error,
    totalRecords,
    cursor: safeCursor,
    setCursor,
    snapshot,
    records,
  };
}
