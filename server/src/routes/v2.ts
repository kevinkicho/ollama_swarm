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
        USE_OLLAMA_DIRECT: process.env.USE_OLLAMA_DIRECT === "1",
        USE_WORKER_PIPELINE_V2: process.env.USE_WORKER_PIPELINE_V2 === "1",
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
  // detailed replay use /api/v2/event-log/runs/:idx (TODO).
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

  return r;
}
