/**
 * Persistent indexes for Debug Log list performance (PR3 + PR6).
 *
 * - logs/event-log-index.json — per-run list rows (mtime-keyed)
 * - logs/archives-index.jsonl — run_started hits from rotated events-*.gz
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { DerivedRunState } from "./EventLogReaderV2.js";
import type { PerRunDebugIndexEntry } from "./eventLogSources.js";

export const EVENT_LOG_INDEX_FILENAME = "event-log-index.json";
export const ARCHIVES_INDEX_FILENAME = "archives-index.jsonl";

export interface EventLogIndexPerRun {
  runId: string;
  bytes: number;
  /** debug.jsonl mtime when this row was written */
  mtimeMs: number;
  lineCount: number;
  derived: DerivedRunState | null;
  indexedAt: number;
}

export interface EventLogIndexFile {
  version: 1;
  updatedAt: number;
  perRun: Record<string, EventLogIndexPerRun>;
}

export interface ArchiveIndexHit {
  archive: string;
  runId: string;
  startedAt: number;
  preset?: string;
  scannedAt: number;
}

export async function loadEventLogIndex(logDir: string): Promise<EventLogIndexFile> {
  const p = path.join(logDir, EVENT_LOG_INDEX_FILENAME);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as EventLogIndexFile;
    if (parsed?.version !== 1 || !parsed.perRun || typeof parsed.perRun !== "object") {
      return { version: 1, updatedAt: 0, perRun: {} };
    }
    return parsed;
  } catch {
    return { version: 1, updatedAt: 0, perRun: {} };
  }
}

export async function saveEventLogIndex(
  logDir: string,
  index: EventLogIndexFile,
): Promise<void> {
  await fs.mkdir(logDir, { recursive: true });
  const p = path.join(logDir, EVENT_LOG_INDEX_FILENAME);
  const body: EventLogIndexFile = {
    version: 1,
    updatedAt: Date.now(),
    perRun: index.perRun,
  };
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body), "utf8");
  await fs.rename(tmp, p);
}

export function entryFromIndex(
  row: EventLogIndexPerRun,
): PerRunDebugIndexEntry {
  return {
    runId: row.runId,
    bytes: row.bytes,
    mtimeMs: row.mtimeMs,
    lineCount: row.lineCount,
    derived: row.derived,
    fromMeta: true, // treated as cached (no full rescan)
  };
}

export function upsertIndexEntry(
  index: EventLogIndexFile,
  entry: PerRunDebugIndexEntry,
): void {
  index.perRun[entry.runId] = {
    runId: entry.runId,
    bytes: entry.bytes,
    mtimeMs: entry.mtimeMs,
    lineCount: entry.lineCount,
    derived: entry.derived,
    indexedAt: Date.now(),
  };
}

/** Append run_started hits for one rotated archive (dedupe by archive+runId). */
export async function appendArchiveIndexHits(
  logDir: string,
  hits: Array<{ archive: string; runId: string; startedAt: number; preset?: string }>,
): Promise<void> {
  if (hits.length === 0) return;
  await fs.mkdir(logDir, { recursive: true });
  const p = path.join(logDir, ARCHIVES_INDEX_FILENAME);
  const now = Date.now();
  const lines = hits.map((h) =>
    JSON.stringify({
      archive: h.archive,
      runId: h.runId,
      startedAt: h.startedAt,
      preset: h.preset,
      scannedAt: now,
    } satisfies ArchiveIndexHit),
  );
  await fs.appendFile(p, lines.join("\n") + "\n", "utf8");
}

/** Load archive index; last write wins per runId. */
export async function loadArchiveIndexHits(
  logDir: string,
): Promise<Map<string, ArchiveIndexHit>> {
  const p = path.join(logDir, ARCHIVES_INDEX_FILENAME);
  const byRun = new Map<string, ArchiveIndexHit>();
  try {
    const raw = await fs.readFile(p, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const hit = JSON.parse(line) as ArchiveIndexHit;
        if (hit?.runId && hit.archive) byRun.set(hit.runId, hit);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* missing */
  }
  return byRun;
}

/**
 * Paginate ascending timestamp records (newest page by default).
 * - First page (no beforeTs): last `limit` records
 * - Older page (beforeTs): last `limit` records with ts < beforeTs
 */
export function paginateLoggedRecords<T extends { ts: number }>(
  records: readonly T[],
  opts: { limit?: number; beforeTs?: number } = {},
): {
  records: T[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  oldestTs?: number;
  newestTs?: number;
  total: number;
} {
  const total = records.length;
  if (total === 0) {
    return { records: [], hasMoreOlder: false, hasMoreNewer: false, total: 0 };
  }
  const limit =
    opts.limit != null && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(2000, Math.floor(opts.limit))
      : undefined;

  let pool = records as T[];
  if (opts.beforeTs != null && Number.isFinite(opts.beforeTs)) {
    pool = records.filter((r) => r.ts < opts.beforeTs!) as T[];
  }

  let page: T[];
  if (limit == null) {
    page = pool as T[];
  } else if (pool.length <= limit) {
    page = pool as T[];
  } else {
    page = pool.slice(-limit) as T[];
  }

  const oldestTs = page.length > 0 ? page[0]!.ts : undefined;
  const newestTs = page.length > 0 ? page[page.length - 1]!.ts : undefined;
  const firstAll = records[0]!.ts;
  const lastAll = records[records.length - 1]!.ts;

  return {
    records: page,
    hasMoreOlder: oldestTs != null ? oldestTs > firstAll : false,
    hasMoreNewer: newestTs != null ? newestTs < lastAll : false,
    oldestTs,
    newestTs,
    total,
  };
}
