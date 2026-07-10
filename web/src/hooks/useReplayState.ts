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
import { apiFetch } from "../lib/apiFetch";

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
  activityLabel?: string;
  activityPhase?: string;
}

export interface ReplayActivityStep {
  ts: number;
  agentId: string;
  agentIndex?: number;
  phase: string;
  label?: string;
  kind?: string;
}

export interface ReplayTodoSnapshot {
  id: string;
  description?: string;
  status: "open" | "claimed" | "committed" | "stale" | "skipped";
  workerId?: string;
  staleReason?: string;
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
  /** Prompt-session activity timeline up to this cursor. */
  activityTimeline: ReadonlyArray<ReplayActivityStep>;
  todos: ReadonlyArray<ReplayTodoSnapshot>;
  findings: ReadonlyArray<{ id: string; text: string; ts: number }>;
  contract: { missionStatement?: string; criteria?: ReadonlyArray<{ description: string; status?: string }> } | null;
  /** Last directive amendment text, if any. */
  directive: string | null;
  /** Latest conformance score (0..100), null if never sampled. */
  conformanceScore: number | null;
  /** Latest drift score (0..1), null if never sampled. */
  driftScore: number | null;
  /** Error events accumulated. */
  errors: ReadonlyArray<{ message: string; ts: number }>;
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
  activityTimeline: [],
  todos: [],
  findings: [],
  contract: null,
  directive: null,
  conformanceScore: null,
  driftScore: null,
  errors: [],
  hasSummary: false,
};

/** Pure reducer — fold records[0..n] into a single snapshot.
 *  Exported for unit tests.
 *
 *  #94 deeper (2026-05-01): coverage extended from 5 → 14 event types.
 *  Added: error, todo_posted/claimed/committed/failed/skipped/replanned,
 *  finding_posted, contract_updated, directive_amended, conformance_sample,
 *  drift_sample. Streaming/latency events still skipped (not load-bearing
 *  for replay — final transcript_append carries the result; agent_latency
 *  is per-attempt diagnostic noise). */
export function reduceToSnapshot(records: ReadonlyArray<ReplayRecord>): ReplaySnapshot {
  const snap: ReplaySnapshot = {
    ...EMPTY_SNAPSHOT,
    transcript: [],
    agents: [],
    todos: [],
    findings: [],
    errors: [],
  };
  // Mutating local copies for accumulation; freeze before return.
  const transcript: Array<ReplaySnapshot["transcript"][number]> = [];
  const agents: Map<string, ReplayAgentSnapshot> = new Map();
  const activityTimeline: ReplayActivityStep[] = [];
  const todos: Map<string, ReplayTodoSnapshot> = new Map();
  const findings: Array<{ id: string; text: string; ts: number }> = [];
  const errors: Array<{ message: string; ts: number }> = [];

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
      case "agent_state": {
        // Wire format is { agent: AgentState }; older flat tests use top-level fields.
        const nested = ev.agent && typeof ev.agent === "object"
          ? (ev.agent as Record<string, unknown>)
          : null;
        const id =
          (nested && typeof nested.id === "string" ? nested.id : undefined)
          ?? (typeof ev.id === "string" ? ev.id : undefined);
        if (id) {
          const src = nested ?? (ev as Record<string, unknown>);
          const prior = agents.get(id) ?? { id };
          agents.set(id, {
            ...prior,
            ...(typeof src.index === "number" ? { index: src.index } : {}),
            ...(typeof src.status === "string" ? { status: src.status } : {}),
            ...(typeof src.port === "number" ? { port: src.port } : {}),
            ...(typeof src.sessionId === "string" ? { sessionId: src.sessionId } : {}),
            ...(typeof src.model === "string" ? { model: src.model } : {}),
            ...(typeof src.activityLabel === "string"
              ? { activityLabel: src.activityLabel }
              : {}),
          });
        }
        break;
      }
      case "agents_roster": {
        agents.clear();
        const list = Array.isArray(ev.agents) ? (ev.agents as Array<Record<string, unknown>>) : [];
        for (const a of list) {
          if (typeof a.id !== "string") continue;
          agents.set(a.id, {
            id: a.id,
            ...(typeof a.index === "number" ? { index: a.index } : {}),
            ...(typeof a.status === "string" ? { status: a.status } : {}),
            ...(typeof a.model === "string" ? { model: a.model } : {}),
          });
        }
        break;
      }
      case "agent_activity": {
        if (typeof ev.agentId === "string" && typeof ev.phase === "string") {
          const step: ReplayActivityStep = {
            ts: typeof ev.ts === "number" ? ev.ts : record.ts,
            agentId: ev.agentId,
            phase: ev.phase,
            ...(typeof ev.agentIndex === "number" ? { agentIndex: ev.agentIndex } : {}),
            ...(typeof ev.label === "string" ? { label: ev.label } : {}),
            ...(typeof ev.kind === "string" ? { kind: ev.kind } : {}),
          };
          activityTimeline.push(step);
          const prior = agents.get(ev.agentId) ?? { id: ev.agentId };
          agents.set(ev.agentId, {
            ...prior,
            ...(typeof ev.agentIndex === "number" ? { index: ev.agentIndex } : {}),
            activityPhase: ev.phase,
            ...(typeof ev.label === "string" ? { activityLabel: ev.label } : {}),
            // Map control-plane phases onto a coarse status for sidebar-like views.
            status:
              ev.phase === "done"
                ? "ready"
                : ev.phase === "retrying"
                  ? "retrying"
                  : "thinking",
          });
        }
        break;
      }
      case "todo_posted":
        if (typeof ev.id === "string") {
          todos.set(ev.id, {
            id: ev.id,
            description: typeof ev.description === "string" ? ev.description : undefined,
            status: "open",
          });
        }
        break;
      case "todo_claimed":
        if (typeof ev.id === "string") {
          const prior = todos.get(ev.id) ?? { id: ev.id, status: "open" as const };
          todos.set(ev.id, {
            ...prior,
            status: "claimed",
            ...(typeof ev.workerId === "string" ? { workerId: ev.workerId } : {}),
          });
        }
        break;
      case "todo_committed":
        if (typeof ev.id === "string") {
          const prior = todos.get(ev.id) ?? { id: ev.id, status: "open" as const };
          todos.set(ev.id, { ...prior, status: "committed" });
        }
        break;
      case "todo_failed":
      case "todo_replanned":
        if (typeof ev.id === "string") {
          const prior = todos.get(ev.id) ?? { id: ev.id, status: "open" as const };
          todos.set(ev.id, {
            ...prior,
            status: "stale",
            ...(typeof ev.reason === "string" ? { staleReason: ev.reason } : {}),
          });
        }
        break;
      case "todo_skipped":
        if (typeof ev.id === "string") {
          const prior = todos.get(ev.id) ?? { id: ev.id, status: "open" as const };
          todos.set(ev.id, { ...prior, status: "skipped" });
        }
        break;
      case "finding_posted":
        if (typeof ev.id === "string" && typeof ev.text === "string") {
          findings.push({ id: ev.id, text: ev.text, ts: record.ts });
        }
        break;
      case "contract_updated":
        if (ev.contract && typeof ev.contract === "object") {
          snap.contract = ev.contract as ReplaySnapshot["contract"];
        }
        break;
      case "directive_amended":
        if (typeof ev.text === "string") snap.directive = ev.text;
        break;
      case "conformance_sample":
        if (typeof ev.score === "number") snap.conformanceScore = ev.score;
        else if (typeof ev.smoothed === "number") snap.conformanceScore = ev.smoothed;
        break;
      case "drift_sample":
        if (typeof ev.score === "number") snap.driftScore = ev.score;
        else if (typeof ev.similarity === "number") snap.driftScore = ev.similarity;
        break;
      case "error":
        if (typeof ev.message === "string") {
          errors.push({ message: ev.message, ts: record.ts });
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
    activityTimeline: Object.freeze(activityTimeline),
    todos: Object.freeze([...todos.values()]),
    findings: Object.freeze(findings),
    errors: Object.freeze(errors),
  };
}

/** Compute what changed between two snapshots. Used by the time-travel
 *  UI's "what happened at this tick?" panel. */
export interface SnapshotDiff {
  phaseChanged: { from: string; to: string } | null;
  newTranscriptIds: string[];
  agentStatusChanges: Array<{ agentId: string; from: string | undefined; to: string | undefined }>;
  todoStatusChanges: Array<{ todoId: string; from: string | undefined; to: string }>;
  newFindingIds: string[];
  newErrors: number;
  conformanceDelta: number | null;
  driftDelta: number | null;
  contractChanged: boolean;
  directiveChanged: boolean;
}

export function diffSnapshots(prev: ReplaySnapshot, curr: ReplaySnapshot): SnapshotDiff {
  const phaseChanged =
    prev.phase !== curr.phase ? { from: prev.phase, to: curr.phase } : null;

  const prevTranscriptIds = new Set(prev.transcript.map((e) => e.id));
  const newTranscriptIds = curr.transcript.filter((e) => !prevTranscriptIds.has(e.id)).map((e) => e.id);

  const prevAgentStatus = new Map(prev.agents.map((a) => [a.id, a.status]));
  const agentStatusChanges: SnapshotDiff["agentStatusChanges"] = [];
  for (const a of curr.agents) {
    const prior = prevAgentStatus.get(a.id);
    if (prior !== a.status) {
      agentStatusChanges.push({ agentId: a.id, from: prior, to: a.status });
    }
  }

  const prevTodoStatus = new Map(prev.todos.map((t) => [t.id, t.status]));
  const todoStatusChanges: SnapshotDiff["todoStatusChanges"] = [];
  for (const t of curr.todos) {
    const prior = prevTodoStatus.get(t.id);
    if (prior !== t.status) {
      todoStatusChanges.push({ todoId: t.id, from: prior, to: t.status });
    }
  }

  const prevFindingIds = new Set(prev.findings.map((f) => f.id));
  const newFindingIds = curr.findings.filter((f) => !prevFindingIds.has(f.id)).map((f) => f.id);

  return {
    phaseChanged,
    newTranscriptIds,
    agentStatusChanges,
    todoStatusChanges,
    newFindingIds,
    newErrors: curr.errors.length - prev.errors.length,
    conformanceDelta:
      prev.conformanceScore !== null && curr.conformanceScore !== null
        ? curr.conformanceScore - prev.conformanceScore
        : null,
    driftDelta:
      prev.driftScore !== null && curr.driftScore !== null
        ? curr.driftScore - prev.driftScore
        : null,
    contractChanged: JSON.stringify(prev.contract) !== JSON.stringify(curr.contract),
    directiveChanged: prev.directive !== curr.directive,
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
  /** Diff between snapshot at cursor-1 vs cursor, useful for showing
   *  "what happened on this tick?" — null when cursor === 0. */
  diff: SnapshotDiff | null;
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
    apiFetch(`/api/v2/event-log/runs/${encodeURIComponent(runId)}`)
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

  const diff = useMemo(() => {
    if (safeCursor === 0) return null;
    const priorSnap = reduceToSnapshot(records.slice(0, safeCursor - 1));
    return diffSnapshots(priorSnap, snapshot);
  }, [records, safeCursor, snapshot]);

  return {
    loading,
    error,
    totalRecords,
    cursor: safeCursor,
    setCursor,
    snapshot,
    diff,
    records,
  };
}
