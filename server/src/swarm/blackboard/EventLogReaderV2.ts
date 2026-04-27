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

/** Derived state from an event log. Minimal V2 view — extracts the
 *  fields a basic event-log UI needs without trying to be a complete
 *  state mirror. Step 6b can extend this as the UI grows. */
export interface DerivedRunState {
  runId?: string;
  preset?: string;
  startedAt?: number;
  finishedAt?: number;
  finalPhase?: string;
  errors: string[];
  transcriptCount: number;
  agentStateUpdates: number;
  /** True if a "run_summary" event was seen (run completed cleanly). */
  hasSummary: boolean;
}

/** Reduce a slice of records into a derived state snapshot. Pure —
 *  no side effects. Useful for replay debugging and the eventual
 *  event-log UI's per-run overview cards. */
export function deriveRunState(slice: RunSlice): DerivedRunState {
  const state: DerivedRunState = {
    errors: [],
    transcriptCount: 0,
    agentStateUpdates: 0,
    hasSummary: false,
  };
  for (const r of slice.records) {
    const ev = r.event;
    switch (ev.type) {
      case "run_started":
        state.startedAt = r.ts;
        if (typeof ev.runId === "string") state.runId = ev.runId;
        if (typeof ev.preset === "string") state.preset = ev.preset;
        break;
      case "swarm_state":
        if (typeof ev.phase === "string") state.finalPhase = ev.phase;
        break;
      case "transcript_append":
        state.transcriptCount += 1;
        break;
      case "agent_state":
        state.agentStateUpdates += 1;
        break;
      case "error":
        if (typeof ev.message === "string") state.errors.push(ev.message);
        break;
      case "run_summary":
        state.hasSummary = true;
        state.finishedAt = r.ts;
        break;
      default:
        // Unknown / future event type — silently skip. The reader
        // is forward-compatible by design.
        break;
    }
  }
  return state;
}
