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
