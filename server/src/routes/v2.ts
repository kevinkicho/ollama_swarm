// V2 Step 6b: read-only endpoint that exposes the event log via
// EventLogReaderV2. Lets the UI render a per-run history derived
// from logs/current.jsonl + rotated event log files.
//
// Read-only: the writer is ws/eventLogger.ts. This route just reads
// and parses. No state mutation, no auth — same trust boundary as
// the rest of /api/*.

import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  parseEventLog,
  splitIntoRuns,
  deriveRunState,
  type DerivedRunState,
  type LoggedRecord,
} from "../swarm/blackboard/EventLogReaderV2.js";

export interface V2RouterDeps {
  /** Absolute path to the JSONL event log. Typically logs/current.jsonl. */
  eventLogPath: string;
}

/** Read all event log files (current.jsonl + rotated events-*.jsonl) and
 *  concatenate their records in chronological order. Bounded to
 *  MAX_LOG_FILES most recent files to avoid unbounded disk reads. */
const MAX_LOG_FILES = 10;

async function readAllEventLogs(eventLogPath: string): Promise<{ records: LoggedRecord[]; malformed: Array<{ lineNumber: number; raw: string; error: string }>; sources: string[] }> {
  const logDir = path.dirname(eventLogPath);
  const allRecords: LoggedRecord[] = [];
  const allMalformed: Array<{ lineNumber: number; raw: string; error: string }> = [];
  const sources: string[] = [];

  // Find all JSONL files in the log directory
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return { records: [], malformed: [], sources: [] };
  }

  const jsonlFiles = entries
    .filter((e) => e.endsWith(".jsonl"))
    .map((e) => path.join(logDir, e))
    .sort((a, b) => {
      // current.jsonl first, then rotated files by name (newest first)
      const aBase = path.basename(a);
      const bBase = path.basename(b);
      if (aBase === "current.jsonl") return -1;
      if (bBase === "current.jsonl") return 1;
      return a > b ? -1 : 1;
    })
    .slice(0, MAX_LOG_FILES);

  for (const filePath of jsonlFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue; // skip unreadable files
    }
    const { records, malformed } = parseEventLog(raw);
    allRecords.push(...records);
    allMalformed.push(...malformed);
    sources.push(filePath);
  }

  return { records: allRecords, malformed: allMalformed, sources };
}

export function v2Router(deps: V2RouterDeps): Router {
  const r = Router();

  // GET /api/v2/status → { flags: {...}, env: {...} }
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
  // Reads ALL event log files (current + rotated) and returns derived
  // state per run slice.
  r.get("/event-log/runs", async (_req: Request, res: Response) => {
    try {
      const { records, malformed, sources } = await readAllEventLogs(deps.eventLogPath);
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
        sources,
        totalRecords: records.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `failed to read event logs: ${msg}` });
    }
  });

  // GET /api/v2/event-log/runs/:runId → per-run record replay
  r.get("/event-log/runs/:runId", async (req: Request, res: Response) => {
    const wantId = req.params.runId;
    if (!wantId || wantId.length > 100) {
      res.status(400).json({ error: "runId required (max 100 chars)" });
      return;
    }
    try {
      const { records, malformed, sources } = await readAllEventLogs(deps.eventLogPath);
      const slices = splitIntoRuns(records);
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
        sources,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `failed to read event logs: ${msg}` });
    }
  });

  return r;
}
