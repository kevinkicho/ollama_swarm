// V2 Step 6a: typed JSONL event-log reader. Reads logs/current.jsonl
// (or any caller-provided JSONL), parses each line as { ts, event },
// and yields typed records. Skips malformed lines (the file may have
// a partial last write if the server was killed mid-flight) without
// erroring — JSONL's whole point is line-independence.
//
// Per ARCHITECTURE-V2.md section 6: the V2 vision is that the UI
// derives all state from this stream rather than maintaining a
// parallel WebSocket-snapshot mirror. This module is the substrate;
// integration into the UI is Step 6b. For now it's testable + usable
// for offline replay/debug.
//
// Companion to ws/eventLogger.ts (the writer). The on-disk format is:
//   { ts: 12345, event: { type: "...", ... } }
// One JSON object per line, with a leading "_session_started"
// sentinel marker per server boot.

import {
  detectStreamAnomalies,
  type StreamAnomalyFinding,
} from "../streamAnomalyDetector.js";

export interface LoggedRecord {
  ts: number;
  event: { type: string } & Record<string, unknown>;
}

export interface ParseLogResult {
  records: LoggedRecord[];
  /** Lines that failed to parse — typically the partial last line of
   *  a JSONL file the server was killed mid-write. Includes line
   *  number + raw text for debugging. */
  malformed: Array<{ lineNumber: number; raw: string; error: string }>;
}

/** Parse a JSONL string into typed records. Skips blank lines and
 *  malformed lines (collected in `malformed`) so a single bad line
 *  doesn't block downstream consumers. */
export function parseEventLog(jsonl: string): ParseLogResult {
  const records: LoggedRecord[] = [];
  const malformed: ParseLogResult["malformed"] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length === 0) continue; // skip blank
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { ts?: unknown }).ts !== "number" ||
        typeof (parsed as { event?: unknown }).event !== "object"
      ) {
        malformed.push({
          lineNumber: i + 1,
          raw,
          error: "missing ts or event field",
        });
        continue;
      }
      const ev = (parsed as { event: unknown }).event;
      if (
        typeof ev !== "object" ||
        ev === null ||
        typeof (ev as { type?: unknown }).type !== "string"
      ) {
        malformed.push({
          lineNumber: i + 1,
          raw,
          error: "event missing string `type`",
        });
        continue;
      }
      records.push(parsed as LoggedRecord);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      malformed.push({ lineNumber: i + 1, raw, error: msg });
    }
  }
  return { records, malformed };
}

/** Group records into runs. Each "_session_started" marker starts a
 *  new session (boot-level), and a "run_started" / "swarm_state idle
 *  → cloning" pair starts a logical run. We split on either signal
 *  so consumers can render per-run timelines. */
export interface RunSlice {
  /** First record's ts in this slice. */
  startedAt: number;
  /** Last record's ts in this slice (or startedAt if only one). */
  endedAt: number;
  /** All records in this slice in original order. */
  records: LoggedRecord[];
  /** True if this slice is a session-boundary slice (started via
   *  "_session_started" sentinel, not a real run start). */
  isSessionBoundary: boolean;
}

export function splitIntoRuns(records: LoggedRecord[]): RunSlice[] {
  const slices: RunSlice[] = [];
  let current: RunSlice | null = null;
  for (const r of records) {
    const t = r.event.type;
    const startsRun =
      t === "_session_started" || t === "run_started";
    if (startsRun) {
      if (current) slices.push(current);
      current = {
        startedAt: r.ts,
        endedAt: r.ts,
        records: [r],
        isSessionBoundary: t === "_session_started",
      };
    } else if (current) {
      current.records.push(r);
      current.endedAt = r.ts;
    } else {
      // Records before any session marker — bucket into a synthetic slice
      // so they aren't lost (e.g. when reading a partial log).
      current = {
        startedAt: r.ts,
        endedAt: r.ts,
        records: [r],
        isSessionBoundary: false,
      };
    }
  }
  if (current) slices.push(current);
  return slices;
}

export interface PhaseStep {
  phase: string;
  ts: number;
}

export interface StreamAnomalySummary {
  kind: StreamAnomalyFinding["kind"];
  pattern: string;
  detail: string;
  agentId?: string;
}

/** Derived state from an event log — flight-recorder summary for the
 *  Debug Log panel. Richer than Runs digests: causal telemetry the
 *  summary artifacts compress away. */
export interface DerivedRunState {
  runId?: string;
  preset?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  finalPhase?: string;
  stopReason?: string;
  errors: string[];
  transcriptCount: number;
  agentStateUpdates: number;
  /** Count of agent_activity control-plane events. */
  agentActivityEvents: number;
  /**
   * Compact activity timeline (waiting/streaming/done with labels) for
   * history / debug inspection — last N session transitions.
   */
  activityTimeline: Array<{
    ts: number;
    agentId: string;
    agentIndex?: number;
    phase: string;
    label?: string;
    kind?: string;
  }>;
  /** True if a "run_summary" event was seen (run completed cleanly). */
  hasSummary: boolean;
  agentCount?: number;
  clonePath?: string;
  phaseTimeline: PhaseStep[];
  eventTypeCounts: Record<string, number>;
  modelShiftCount: number;
  brainFallbackCount: number;
  todoClaimed: number;
  todoFailed: number;
  todoReplanned: number;
  todoSkipped: number;
  streamingEventCount: number;
  streamingEndCount: number;
  amendmentCount: number;
  conformanceSampleCount: number;
  lastConformanceScore?: number;
  driftSampleCount: number;
  lastDriftSimilarity?: number;
  coldStartCount: number;
  maxColdStartMs?: number;
  streamAnomalies: StreamAnomalySummary[];
  /** Heuristic flags for the debug panel (no_summary, stream_loop, …). */
  anomalyFlags: string[];
  /** True when runId came from stamped events, not run_started. */
  runIdInferred?: boolean;
}

function bumpTypeCount(counts: Record<string, number>, type: string): void {
  counts[type] = (counts[type] ?? 0) + 1;
}

function scanAgentStream(
  agentId: string,
  text: string,
  out: StreamAnomalySummary[],
): void {
  if (text.length < 2_000) return;
  const findings = detectStreamAnomalies(text, { minLength: 2_000, minPhraseCount: 6 });
  for (const f of findings) {
    out.push({ kind: f.kind, pattern: f.pattern, detail: f.detail, agentId });
  }
}

export function computeAnomalyFlags(state: DerivedRunState): string[] {
  const flags: string[] = [];
  if (state.runId && state.transcriptCount > 0 && !state.hasSummary) {
    flags.push("no_summary");
  }
  if (
    state.streamingEventCount > 0
    && state.agentStateUpdates === 0
    && state.agentActivityEvents === 0
  ) {
    flags.push("activity_gap");
  }
  if (state.errors.length > 0) flags.push("errors");
  if (state.streamAnomalies.length > 0) flags.push("stream_loop");
  if (state.modelShiftCount + state.brainFallbackCount > 0) flags.push("model_failover");
  if (state.todoFailed > 0) flags.push("todo_failures");
  if (state.runId && !state.hasSummary && state.finalPhase === "executing") {
    flags.push("in_flight");
  }
  return flags;
}

/** Reduce a slice of records into a derived state snapshot. Pure —
 *  no side effects. Useful for replay debugging and the debug panel. */
export function deriveRunState(slice: RunSlice): DerivedRunState {
  const state: DerivedRunState = {
    errors: [],
    transcriptCount: 0,
    agentStateUpdates: 0,
    agentActivityEvents: 0,
    activityTimeline: [],
    hasSummary: false,
    phaseTimeline: [],
    eventTypeCounts: {},
    modelShiftCount: 0,
    brainFallbackCount: 0,
    todoClaimed: 0,
    todoFailed: 0,
    todoReplanned: 0,
    todoSkipped: 0,
    streamingEventCount: 0,
    streamingEndCount: 0,
    amendmentCount: 0,
    conformanceSampleCount: 0,
    driftSampleCount: 0,
    coldStartCount: 0,
    streamAnomalies: [],
    anomalyFlags: [],
  };

  const streamBuffers = new Map<string, string>();
  const runIdVotes = new Map<string, number>();

  for (const r of slice.records) {
    const ev = r.event;
    const t = ev.type;
    bumpTypeCount(state.eventTypeCounts, t);
    if (typeof ev.runId === "string" && ev.runId.length > 0) {
      runIdVotes.set(ev.runId, (runIdVotes.get(ev.runId) ?? 0) + 1);
    }

    switch (t) {
      case "run_started":
        state.startedAt = r.ts;
        if (typeof ev.runId === "string") state.runId = ev.runId;
        if (typeof ev.preset === "string") state.preset = ev.preset;
        if (typeof ev.agentCount === "number") state.agentCount = ev.agentCount;
        if (typeof ev.clonePath === "string") state.clonePath = ev.clonePath;
        break;
      case "swarm_state":
        if (typeof ev.phase === "string") {
          state.finalPhase = ev.phase;
          const last = state.phaseTimeline[state.phaseTimeline.length - 1];
          if (!last || last.phase !== ev.phase) {
            state.phaseTimeline.push({ phase: ev.phase, ts: r.ts });
          }
        }
        break;
      case "transcript_append":
        state.transcriptCount += 1;
        break;
      case "agent_state":
        state.agentStateUpdates += 1;
        break;
      case "agent_activity": {
        state.agentActivityEvents += 1;
        if (typeof ev.agentId === "string" && typeof ev.phase === "string") {
          state.activityTimeline.push({
            ts: r.ts,
            agentId: ev.agentId,
            ...(typeof ev.agentIndex === "number" ? { agentIndex: ev.agentIndex } : {}),
            phase: ev.phase,
            ...(typeof ev.label === "string" ? { label: ev.label } : {}),
            ...(typeof ev.kind === "string" ? { kind: ev.kind } : {}),
          });
          // Bound memory on very long autonomous runs.
          if (state.activityTimeline.length > 200) {
            state.activityTimeline.splice(0, state.activityTimeline.length - 200);
          }
        }
        break;
      }
      case "agents_roster":
        // Roster clear/replace is a lifecycle boundary (pipeline handoff).
        break;
      case "agent_streaming":
        state.streamingEventCount += 1;
        if (typeof ev.agentId === "string" && typeof ev.text === "string") {
          streamBuffers.set(ev.agentId, ev.text);
        }
        break;
      case "agent_streaming_end":
        state.streamingEndCount += 1;
        if (typeof ev.agentId === "string") {
          const text = streamBuffers.get(ev.agentId) ?? "";
          scanAgentStream(ev.agentId, text, state.streamAnomalies);
          streamBuffers.delete(ev.agentId);
        }
        break;
      case "error":
        if (typeof ev.message === "string") state.errors.push(ev.message);
        break;
      case "model_shift":
        state.modelShiftCount += 1;
        break;
      case "brain-fallback":
        state.brainFallbackCount += 1;
        break;
      case "todo_claimed":
        state.todoClaimed += 1;
        break;
      case "todo_failed":
        state.todoFailed += 1;
        break;
      case "todo_replanned":
        state.todoReplanned += 1;
        break;
      case "todo_skipped":
        state.todoSkipped += 1;
        break;
      case "directive_amended":
        state.amendmentCount += 1;
        break;
      case "conformance_sample":
        state.conformanceSampleCount += 1;
        if (typeof ev.score === "number") state.lastConformanceScore = ev.score;
        break;
      case "drift_sample":
        state.driftSampleCount += 1;
        if (typeof ev.similarity === "number") state.lastDriftSimilarity = ev.similarity;
        break;
      case "cold_start":
        state.coldStartCount += 1;
        if (typeof ev.elapsedMs === "number") {
          state.maxColdStartMs = Math.max(state.maxColdStartMs ?? 0, ev.elapsedMs);
        }
        break;
      case "run_summary":
        state.hasSummary = true;
        state.finishedAt = r.ts;
        {
          const summary = ev.summary as { stopReason?: string } | undefined;
          const stopReason = summary?.stopReason;
          if (typeof stopReason === "string") state.stopReason = stopReason;
          if (stopReason === "completed") {
            state.finalPhase = "completed";
          } else if (stopReason) {
            state.finalPhase = "stopped";
          } else if (
            !state.finalPhase ||
            !["completed", "stopped", "failed"].includes(state.finalPhase)
          ) {
            state.finalPhase = "completed";
          }
        }
        break;
      default:
        break;
    }
  }

  for (const [agentId, text] of streamBuffers) {
    scanAgentStream(agentId, text, state.streamAnomalies);
  }

  if (!state.runId && runIdVotes.size > 0) {
    let bestId = "";
    let bestVotes = 0;
    for (const [id, votes] of runIdVotes) {
      if (votes > bestVotes) {
        bestId = id;
        bestVotes = votes;
      }
    }
    state.runId = bestId;
    state.runIdInferred = true;
  }

  if (state.startedAt == null) state.startedAt = slice.startedAt;

  if (!state.finalPhase) {
    if (state.streamingEventCount > 0 || state.agentStateUpdates > 0) {
      state.finalPhase = "active";
    }
  }

  const endTs = state.finishedAt ?? slice.endedAt;
  if (state.startedAt != null && endTs != null) {
    state.durationMs = Math.max(0, endTs - state.startedAt);
  }

  state.anomalyFlags = computeAnomalyFlags(state);
  return state;
}
