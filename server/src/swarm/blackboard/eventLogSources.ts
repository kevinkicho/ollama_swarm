// Global event log sources under logs/:
//   events-*.jsonl.gz  — rotated broadcast stream (historical)
//   current.jsonl      — active tail
//   <runId>/debug.jsonl — per-run debug (best source for completed runs)

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import {
  parseEventLog,
  splitIntoRuns,
  deriveRunState,
  computeAnomalyFlags,
  type DerivedRunState,
  type LoggedRecord,
  type RunSlice,
} from "./EventLogReaderV2.js";

/** Archives scanned for run_started index on list (lightweight). */
export const ARCHIVE_INDEX_LIMIT = 40;
/** Archives merged for full replay on drill-down. */
export const MAX_GZ_ARCHIVES_REPLAY = 60;
/** List view: only read the tail of current.jsonl (live segments are recent). */
export const CURRENT_TAIL_MAX_BYTES = 4 * 1024 * 1024;
/** List view: scan only the head of each decompressed archive for run_started. */
export const MAX_ARCHIVE_INDEX_DECOMPRESSED_BYTES = 512 * 1024;
/** Per-run debug.jsonl: full read+parse below this size; above uses head/tail + stream scan. */
export const PER_RUN_INDEX_FULL_READ_MAX_BYTES = 2 * 1024 * 1024;
/** Bytes read from the start of a large per-run debug log for run_started / early state. */
export const PER_RUN_INDEX_HEAD_BYTES = 256 * 1024;
/** Bytes read from the end of a large per-run debug log for run_summary / final state. */
export const PER_RUN_INDEX_TAIL_BYTES = 768 * 1024;
/** In-memory cache TTL for buildEventLogRunList (ms). */
export const EVENT_LOG_LIST_CACHE_TTL_MS = 45_000;

const EVENT_TYPE_RE = /"type"\s*:\s*"([^"\\]+)"/;

type EventLogListResult = Awaited<ReturnType<typeof buildEventLogRunListUncached>>;

let eventLogListCache: { key: string; at: number; value: EventLogListResult } | null = null;

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReadAllEventLogsResult {
  records: LoggedRecord[];
  malformed: Array<{ lineNumber: number; raw: string; error: string }>;
  sources: string[];
  archivesTotal: number;
  archivesRead: number;
}

function readUtf8File(filePath: string, buf: Buffer): string {
  if (filePath.endsWith(".gz")) {
    return zlib.gunzipSync(buf).toString("utf8");
  }
  return buf.toString("utf8");
}

/** Read up to maxBytes from the start of a file (drops a partial last line when truncated). */
export async function readFileHeadUtf8(filePath: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size <= maxBytes) {
      return (await fh.readFile()).toString("utf8");
    }
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, buf.length, 0);
    let text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl >= 0) text = text.slice(0, lastNl + 1);
    return text;
  } finally {
    await fh.close();
  }
}

/** Read up to maxBytes from the end of a file (drops a partial first line). */
export async function readFileTailUtf8(filePath: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size <= maxBytes) {
      return (await fh.readFile()).toString("utf8");
    }
    const start = size - maxBytes;
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    const firstNl = text.indexOf("\n");
    if (firstNl >= 0) text = text.slice(firstNl + 1);
    return text;
  } finally {
    await fh.close();
  }
}

function parseArchiveRunStartedLines(text: string): Array<{
  runId: string;
  preset?: string;
  startedAt: number;
}> {
  const found: Array<{ runId: string; preset?: string; startedAt: number }> = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"run_started"')) continue;
    try {
      const parsed = JSON.parse(line) as {
        ts: number;
        event: { type: string; runId?: string; preset?: string };
      };
      if (parsed.event?.type !== "run_started" || !parsed.event.runId) continue;
      found.push({
        runId: parsed.event.runId,
        preset: parsed.event.preset,
        startedAt: parsed.ts,
      });
    } catch {
      // skip bad line
    }
  }
  return found;
}

function isRotatedArchive(name: string): boolean {
  return name.startsWith("events-") && (name.endsWith(".jsonl.gz") || name.endsWith(".jsonl"));
}

async function listArchiveNames(logDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(logDir);
    return entries.filter(isRotatedArchive).sort();
  } catch {
    return [];
  }
}

/** Full merge for drill-down replay (bounded). */
export async function readAllEventLogs(
  eventLogPath: string,
  maxArchives = MAX_GZ_ARCHIVES_REPLAY,
): Promise<ReadAllEventLogsResult> {
  const logDir = path.dirname(eventLogPath);
  const allRecords: LoggedRecord[] = [];
  const allMalformed: ReadAllEventLogsResult["malformed"] = [];
  const sources: string[] = [];

  const archives = await listArchiveNames(logDir);
  const recentArchives = archives.slice(-maxArchives);

  for (const name of recentArchives) {
    const filePath = path.join(logDir, name);
    try {
      const buf = await fs.readFile(filePath);
      const { records, malformed } = parseEventLog(readUtf8File(filePath, buf));
      allRecords.push(...records);
      allMalformed.push(...malformed);
      sources.push(filePath);
    } catch {
      // skip
    }
  }

  try {
    const raw = await fs.readFile(eventLogPath, "utf8");
    const { records, malformed } = parseEventLog(raw);
    allRecords.push(...records);
    allMalformed.push(...malformed);
    sources.push(eventLogPath);
  } catch {
    // no tail file
  }

  return {
    records: allRecords,
    malformed: allMalformed,
    sources,
    archivesTotal: archives.length,
    archivesRead: recentArchives.length,
  };
}

/** Read only the active tail file (fast path for live segment). */
export async function readTailEventLog(
  eventLogPath: string,
  maxBytes = CURRENT_TAIL_MAX_BYTES,
): Promise<LoggedRecord[]> {
  try {
    const raw = await readFileTailUtf8(eventLogPath, maxBytes);
    return parseEventLog(raw).records;
  } catch {
    return [];
  }
}

export interface PerRunDebugIndexEntry {
  runId: string;
  bytes: number;
  mtimeMs: number;
  lineCount: number;
  derived: DerivedRunState | null;
}

/** One pass over a debug log: line count + event-type histogram (no full JSON parse). */
async function streamPerRunDebugMetrics(
  debugPath: string,
): Promise<{ lineCount: number; typeCounts: Record<string, number> }> {
  const typeCounts: Record<string, number> = {};
  let lineCount = 0;
  const rl = readline.createInterface({
    input: createReadStream(debugPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      lineCount += 1;
      const match = line.match(EVENT_TYPE_RE);
      if (!match) continue;
      const t = match[1];
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
  } finally {
    rl.close();
  }
  return { lineCount, typeCounts };
}

function applyTypeCountsToDerived(derived: DerivedRunState, typeCounts: Record<string, number>): void {
  derived.eventTypeCounts = { ...typeCounts };
  derived.transcriptCount = typeCounts.transcript_append ?? 0;
  derived.agentStateUpdates = typeCounts.agent_state ?? 0;
  derived.streamingEventCount = typeCounts.agent_streaming ?? 0;
  derived.streamingEndCount = typeCounts.agent_streaming_end ?? 0;
  derived.todoClaimed = typeCounts.todo_claimed ?? 0;
  derived.todoFailed = typeCounts.todo_failed ?? 0;
  derived.todoReplanned = typeCounts.todo_replanned ?? 0;
  derived.todoSkipped = typeCounts.todo_skipped ?? 0;
  derived.modelShiftCount = typeCounts.model_shift ?? 0;
  derived.brainFallbackCount = typeCounts["brain-fallback"] ?? 0;
  derived.amendmentCount = typeCounts.directive_amended ?? 0;
  derived.conformanceSampleCount = typeCounts.conformance_sample ?? 0;
  derived.driftSampleCount = typeCounts.drift_sample ?? 0;
  derived.coldStartCount = typeCounts.cold_start ?? 0;
  derived.streamAnomalies = [];
  derived.anomalyFlags = computeAnomalyFlags(derived);
}

async function indexLargePerRunDebugLog(
  debugPath: string,
): Promise<{ lineCount: number; derived: DerivedRunState | null }> {
  const [headText, tailText, metrics] = await Promise.all([
    readFileHeadUtf8(debugPath, PER_RUN_INDEX_HEAD_BYTES),
    readFileTailUtf8(debugPath, PER_RUN_INDEX_TAIL_BYTES),
    streamPerRunDebugMetrics(debugPath),
  ]);
  const headRecords = parseEventLog(headText).records;
  const tailRecords = parseEventLog(tailText).records;
  if (headRecords.length === 0 && tailRecords.length === 0 && metrics.lineCount === 0) {
    return { lineCount: 0, derived: null };
  }
  const bookends = [...headRecords, ...tailRecords];
  const derived = deriveRunState(sliceFromRecords(bookends));
  applyTypeCountsToDerived(derived, metrics.typeCounts);
  return { lineCount: metrics.lineCount, derived };
}

async function indexOnePerRunDebugLog(
  logDir: string,
  runId: string,
): Promise<PerRunDebugIndexEntry | null> {
  const debugPath = path.join(logDir, runId, "debug.jsonl");
  try {
    const st = await fs.stat(debugPath);
    let lineCount = 0;
    let derived: DerivedRunState | null = null;
    try {
      if (st.size <= PER_RUN_INDEX_FULL_READ_MAX_BYTES) {
        const raw = await fs.readFile(debugPath, "utf8");
        const { records } = parseEventLog(raw);
        lineCount = records.length;
        if (records.length > 0) {
          derived = deriveRunState(sliceFromRecords(records));
        }
      } else {
        const large = await indexLargePerRunDebugLog(debugPath);
        lineCount = large.lineCount;
        derived = large.derived;
      }
    } catch {
      lineCount = 0;
    }
    return { runId, bytes: st.size, mtimeMs: st.mtimeMs, lineCount, derived };
  } catch {
    return null;
  }
}

export async function indexPerRunDebugLogs(logDir: string): Promise<PerRunDebugIndexEntry[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const runIds = entries.filter((e) => e.isDirectory() && UUID_DIR.test(e.name)).map((e) => e.name);
  const indexed = await Promise.all(runIds.map((id) => indexOnePerRunDebugLog(logDir, id)));
  return indexed.filter((e): e is PerRunDebugIndexEntry => e != null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readPerRunDebugLog(
  logDir: string,
  runId: string,
): Promise<{ records: LoggedRecord[]; malformed: ReadAllEventLogsResult["malformed"]; path: string } | null> {
  const debugPath = path.join(logDir, runId, "debug.jsonl");
  try {
    const raw = await fs.readFile(debugPath, "utf8");
    const { records, malformed } = parseEventLog(raw);
    return { records, malformed, path: debugPath };
  } catch {
    return null;
  }
}

export interface MergedRunEntry {
  derived: DerivedRunState;
  recordCount: number;
  isSessionBoundary: boolean;
  sliceIndex: number;
  source: "global" | "per-run-debug" | "archive-index";
}

function sliceFromRecords(records: LoggedRecord[]): RunSlice {
  return {
    startedAt: records[0]?.ts ?? 0,
    endedAt: records[records.length - 1]?.ts ?? 0,
    records,
    isSessionBoundary: false,
  };
}

/** Fast run list: per-run debug folders + current tail + archive run_started index. */
export async function buildEventLogRunList(
  eventLogPath: string,
  logDir: string,
): Promise<EventLogListResult> {
  const key = `${logDir}|${eventLogPath}`;
  const now = Date.now();
  if (
    eventLogListCache &&
    eventLogListCache.key === key &&
    now - eventLogListCache.at < EVENT_LOG_LIST_CACHE_TTL_MS
  ) {
    return eventLogListCache.value;
  }
  const value = await buildEventLogRunListUncached(eventLogPath, logDir);
  eventLogListCache = { key, at: now, value };
  return value;
}

/** Clears the in-memory list cache (tests). */
export function clearEventLogListCache(): void {
  eventLogListCache = null;
}

async function buildEventLogRunListUncached(
  eventLogPath: string,
  logDir: string,
): Promise<{
  runs: MergedRunEntry[];
  archivesTotal: number;
  archivesIndexed: number;
  perRunDebugCount: number;
  tailRecordCount: number;
}> {
  const archives = await listArchiveNames(logDir);
  const [perRunDirs, tailRecords] = await Promise.all([
    indexPerRunDebugLogs(logDir),
    readTailEventLog(eventLogPath),
  ]);
  const runs: MergedRunEntry[] = [];
  const seen = new Set<string>();
  let sliceIndex = 0;

  for (const dir of perRunDirs) {
    if (dir.lineCount === 0) continue;
    seen.add(dir.runId);
    const derived =
      dir.derived ??
      ({
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
        runId: dir.runId,
        finalPhase: "archived",
      } satisfies DerivedRunState);
    runs.push({
      sliceIndex: sliceIndex++,
      derived,
      recordCount: dir.lineCount,
      isSessionBoundary: false,
      source: "per-run-debug",
    });
  }

  for (const slice of splitIntoRuns(tailRecords)) {
    const derived = deriveRunState(slice);
    if (derived.runId && seen.has(derived.runId)) continue;
    if (derived.runId) seen.add(derived.runId);
    runs.push({
      sliceIndex: sliceIndex++,
      derived,
      recordCount: slice.records.length,
      isSessionBoundary: slice.isSessionBoundary,
      source: "global",
    });
  }

  const indexArchives = archives.slice(-ARCHIVE_INDEX_LIMIT);
  const archiveHits = await Promise.all(
    indexArchives.map(async (name) => {
      const filePath = path.join(logDir, name);
      try {
        const buf = await fs.readFile(filePath);
        let text: string;
        if (filePath.endsWith(".gz")) {
          text = zlib
            .gunzipSync(buf, { maxOutputLength: MAX_ARCHIVE_INDEX_DECOMPRESSED_BYTES })
            .toString("utf8");
        } else if (buf.length > MAX_ARCHIVE_INDEX_DECOMPRESSED_BYTES) {
          text = buf.subarray(0, MAX_ARCHIVE_INDEX_DECOMPRESSED_BYTES).toString("utf8");
        } else {
          text = buf.toString("utf8");
        }
        return parseArchiveRunStartedLines(text);
      } catch {
        return [];
      }
    }),
  );
  for (const hits of archiveHits) {
    for (const hit of hits) {
      if (seen.has(hit.runId)) continue;
      seen.add(hit.runId);
      runs.push({
        sliceIndex: sliceIndex++,
        derived: {
          errors: [],
          transcriptCount: 0,
          agentStateUpdates: 0,
          agentActivityEvents: 0,
          activityTimeline: [],
          hasSummary: false,
          phaseTimeline: [],
          eventTypeCounts: { run_started: 1 },
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
          runId: hit.runId,
          preset: hit.preset,
          startedAt: hit.startedAt,
          finalPhase: "archived",
        },
        recordCount: 0,
        isSessionBoundary: false,
        source: "archive-index",
      });
    }
  }

  runs.sort((a, b) => {
    const ta = b.derived.finishedAt ?? b.derived.startedAt ?? 0;
    const tb = a.derived.finishedAt ?? a.derived.startedAt ?? 0;
    return ta - tb;
  });
  runs.forEach((r, i) => {
    r.sliceIndex = i;
  });

  return {
    runs,
    archivesTotal: archives.length,
    archivesIndexed: indexArchives.length,
    perRunDebugCount: perRunDirs.length,
    tailRecordCount: tailRecords.length,
  };
}

export async function findRunReplay(
  logDir: string,
  eventLogPath: string,
  wantId: string,
): Promise<{ slice: RunSlice; source: "global" | "per-run-debug" } | null> {
  const perRun = await readPerRunDebugLog(logDir, wantId);
  if (perRun && perRun.records.length > 0) {
    return { slice: sliceFromRecords(perRun.records), source: "per-run-debug" };
  }

  const { records } = await readAllEventLogs(eventLogPath);
  const slices = splitIntoRuns(records);
  const globalMatch = slices.find((s) => deriveRunState(s).runId === wantId);
  if (globalMatch) {
    return { slice: globalMatch, source: "global" };
  }

  return null;
}