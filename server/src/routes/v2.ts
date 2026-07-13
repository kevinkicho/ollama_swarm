// V2 Step 6b: read-only event-log API for the Debug Log panel.

import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  parseEventLog,
  splitIntoRuns,
  deriveRunState,
} from "../swarm/blackboard/EventLogReaderV2.js";
import {
  buildEventLogRunList,
  findRunReplay,
  readAllEventLogs,
  readPerRunDebugLog,
} from "../swarm/blackboard/eventLogSources.js";

export interface V2RouterDeps {
  eventLogPath: string;
}

async function perRunDebugLog(
  logDir: string,
  runId: string,
): Promise<{ relativePath: string; bytes: number } | null> {
  const rel = path.join(runId, "debug.jsonl");
  const abs = path.join(logDir, rel);
  try {
    const s = await fs.stat(abs);
    return { relativePath: rel.replace(/\\/g, "/"), bytes: s.size };
  } catch {
    return null;
  }
}

export function v2Router(deps: V2RouterDeps): Router {
  const logDir = path.dirname(deps.eventLogPath);
  const r = Router();

  r.get("/status", (_req: Request, res: Response) => {
    res.json({
      flags: {
        USE_OLLAMA_DIRECT: config.USE_OLLAMA_DIRECT ? "1" : "0",
        USE_WORKER_PIPELINE_V2: config.USE_WORKER_PIPELINE_V2 ? "1" : "0",
      },
      eventLogPath: deps.eventLogPath,
      v2Substrates: {
        eventLogReaderV2: "server/src/swarm/blackboard/EventLogReaderV2.ts (Step 6a)",
      },
    });
  });

  r.get("/event-log/runs", async (req: Request, res: Response) => {
    try {
      const list = await buildEventLogRunList(deps.eventLogPath, logDir);
      const total = list.runs.length;
      // PR2: optional server-side pagination (client still pages for UX).
      const q = (req.query ?? {}) as Record<string, unknown>;
      const limitRaw = Number(q.limit);
      const offsetRaw = Number(q.offset);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(200, Math.floor(limitRaw))
          : undefined;
      const offset =
        Number.isFinite(offsetRaw) && offsetRaw > 0
          ? Math.floor(offsetRaw)
          : 0;
      const runs =
        limit != null
          ? list.runs.slice(offset, offset + limit)
          : list.runs;
      res.json({
        runs,
        sliceCount: runs.length,
        total,
        offset,
        limit: limit ?? total,
        hasMore: limit != null ? offset + runs.length < total : false,
        malformed: 0,
        sources: [deps.eventLogPath],
        totalRecords: list.tailRecordCount,
        logDir,
        eventLogPath: deps.eventLogPath,
        archivesTotal: list.archivesTotal,
        archivesRead: list.archivesIndexed,
        perRunDebugCount: list.perRunDebugCount,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `failed to read event logs: ${msg}` });
    }
  });

  r.get("/event-log/slices/:index", async (req: Request, res: Response) => {
    const raw = req.params.index;
    const indexStr = typeof raw === "string" ? raw : raw?.[0];
    const sliceIndex = Number.parseInt(indexStr ?? "", 10);
    if (!Number.isFinite(sliceIndex) || sliceIndex < 0) {
      res.status(400).json({ error: "slice index must be a non-negative integer" });
      return;
    }
    try {
      const list = await buildEventLogRunList(deps.eventLogPath, logDir);
      const entry = list.runs[sliceIndex];
      if (!entry?.derived.runId) {
        res.status(404).json({ error: `no run at slice index ${sliceIndex}` });
        return;
      }
      const replay = await findRunReplay(logDir, deps.eventLogPath, entry.derived.runId);
      if (!replay) {
        res.status(404).json({ error: `no replay for ${entry.derived.runId}` });
        return;
      }
      const derived = deriveRunState(replay.slice);
      const debugLog = await perRunDebugLog(logDir, entry.derived.runId);
      res.json({
        sliceIndex,
        runId: entry.derived.runId,
        derived,
        records: replay.slice.records,
        isSessionBoundary: replay.slice.isSessionBoundary,
        source: replay.source,
        logDir,
        debugLog,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `failed to read event logs: ${msg}` });
    }
  });

  r.get("/event-log/runs/:runId", async (req: Request, res: Response) => {
    const rawId = req.params.runId;
    const wantId = typeof rawId === "string" ? rawId : rawId?.[0];
    if (!wantId || wantId.length > 100) {
      res.status(400).json({ error: "runId required (max 100 chars)" });
      return;
    }
    try {
      const replay = await findRunReplay(logDir, deps.eventLogPath, wantId);
      if (!replay) {
        res.status(404).json({
          error: `no run with id ${wantId}`,
          hint: "Checked logs/<runId>/debug.jsonl, recent archives, and current.jsonl",
        });
        return;
      }
      const derived = deriveRunState(replay.slice);
      const debugLog = await perRunDebugLog(logDir, wantId);
      const globalMeta =
        replay.source === "global" ? await readAllEventLogs(deps.eventLogPath) : null;
      res.json({
        runId: wantId,
        derived,
        records: replay.slice.records,
        isSessionBoundary: replay.slice.isSessionBoundary,
        source: replay.source,
        malformed: globalMeta?.malformed.length ?? 0,
        sources: globalMeta?.sources ?? [path.join(logDir, wantId, "debug.jsonl")],
        logDir,
        debugLog,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `failed to read event logs: ${msg}` });
    }
  });

  return r;
}

export { parseEventLog };