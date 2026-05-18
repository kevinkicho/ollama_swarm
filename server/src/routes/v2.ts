// V2 Step 6b: read-only endpoint that exposes the event log via
// EventLogReaderV2. Lets the UI render a per-run history derived
// from logs/current.jsonl rather than only the WebSocket-snapshot
// state. Useful for offline replay + crash-recovery.
//
// Read-only: the writer is ws/eventLogger.ts. This route just reads
// and parses. No state mutation, no auth — same trust boundary as
// the rest of /api/*.

import fs from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  parseEventLog,
  splitIntoRuns,
  deriveRunState,
  type DerivedRunState,
} from "../swarm/blackboard/EventLogReaderV2.js";

export interface V2RouterDeps {
  /** Absolute path to the JSONL event log. Typically logs/current.jsonl. */
  eventLogPath: string;
}

export function v2Router(deps: V2RouterDeps): Router {
  const r = Router();

  // GET /api/v2/status → { flags: {...}, env: {...} }
  // Reports which V2 flags are active so Kevin can verify the dev
  // server picked up the env vars correctly. Cheap diagnostic — no
  // expensive operations.
  r.get("/status", (_req: Request, res: Response) => {
    res.json({
      flags: {
        USE_OLLAMA_DIRECT: config.USE_OLLAMA_DIRECT ? "1" : "0",
        USE_WORKER_PIPELINE_V2: config.USE_WORKER_PIPELINE_V2 ? "1" : "0",
      },
      eventLogPath: deps.eventLogPath,
      v2Substrates: {
        runStateMachine: "shared/src/runStateMachine.ts (Step 3a)",
        runStateObserver: "server/src/swarm/blackboard/RunStateObserver.ts (Step 3b)",
        todoQueueV2: "server/src/swarm/blackboard/TodoQueue.ts (Step 5a)",
        workerPipelineV2: "server/src/swarm/blackboard/WorkerPipeline.ts (Step 5b)",
        v2Adapters: "server/src/swarm/blackboard/v2Adapters.ts (Step 5c.2)",
        eventLogReaderV2: "server/src/swarm/blackboard/EventLogReaderV2.ts (Step 6a)",
      },
    });
  });

  // GET /api/v2/event-log/runs → { runs: [{ derived, recordCount }] }
  // Reads the event log, parses + slices into runs, and returns
  // derived state per slice. Suitable for a sidebar list — for
  // detailed per-run records use /api/v2/event-log/runs/:runId.
  r.get("/event-log/runs", async (_req: Request, res: Response) => {
    let raw: string;
    try {
      raw = await fs.readFile(deps.eventLogPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // ENOENT is the "no log yet" case — return empty rather than 500.
      if (/ENOENT/.test(msg)) {
        res.json({ runs: [], malformed: 0, source: deps.eventLogPath });
        return;
      }
      res.status(500).json({ error: `failed to read event log: ${msg}` });
      return;
    }
    const { records, malformed } = parseEventLog(raw);
    const slices = splitIntoRuns(records);
    const runs: Array<{ derived: DerivedRunState; recordCount: number; isSessionBoundary: boolean }> =
      slices.map((s) => ({
        derived: deriveRunState(s),
        recordCount: s.records.length,
        isSessionBoundary: s.isSessionBoundary,
      }));
    res.json({
      runs,
      malformed: malformed.length,
      source: deps.eventLogPath,
      totalRecords: records.length,
    });
  });

  // V2 Step 6c first thin slice (2026-05-01): per-run record replay.
  // The aggregated /event-log/runs endpoint is enough for a sidebar
  // list, but the eventual UI cutover needs the FULL record stream
  // for any specific run so it can re-derive state without going
  // through the WS path. This endpoint unblocks that work without
  // touching any WS dispatch code yet.
  //
  // Returns: { runId, derived, records: LoggedRecord[], isSessionBoundary, malformed }
  // 404 if no slice has the requested runId. Records are returned in
  // log order — caller's responsibility to fold into UI state.
  r.get("/event-log/runs/:runId", async (req: Request, res: Response) => {
    const wantId = req.params.runId;
    if (!wantId || wantId.length > 100) {
      res.status(400).json({ error: "runId required (max 100 chars)" });
      return;
    }
    let raw: string;
    try {
      raw = await fs.readFile(deps.eventLogPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(msg)) {
        res.status(404).json({ error: `no event log at ${deps.eventLogPath}` });
        return;
      }
      res.status(500).json({ error: `failed to read event log: ${msg}` });
      return;
    }
    const { records, malformed } = parseEventLog(raw);
    const slices = splitIntoRuns(records);
    // Match by either the run_started event's runId or a derived runId.
    // Slices are forward-compat — if a future slice format hides the
    // runId behind a derived field, we still find it.
    const matched = slices.find((s) => {
      const derived = deriveRunState(s);
      return derived.runId === wantId;
    });
    if (!matched) {
      res.status(404).json({ error: `no run with id ${wantId}`, totalSlices: slices.length });
      return;
    }
    res.json({
      runId: wantId,
      derived: deriveRunState(matched),
      records: matched.records,
      isSessionBoundary: matched.isSessionBoundary,
      malformed: malformed.length,
      source: deps.eventLogPath,
    });
  });

  return r;
}
