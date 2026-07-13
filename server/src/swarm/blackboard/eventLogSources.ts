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
/** Max total bytes when merging rotated debug segments for replay. */
export const PER_RUN_REPLAY_MAX_BYTES = 12 * 1024 * 1024;
/** Max rotated debug archives to merge (oldest first, newest last). */
export const PER_RUN_ROTATED_ARCHIVE_LIMIT = 20;

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
  /** True when list row came from debug.meta.json (no full debug scan). */
  fromMeta?: boolean;
}

/** Sidecar written beside debug.jsonl so list build is O(small reads). */
export interface DebugMetaSidecar {
  version: 1;
  runId: string;
  startedAt?: number;
  finishedAt?: number;
  preset?: string;
  lineCount: number;
  bytes: number;
  stopReason?: string;
  hasSummary?: boolean;
  /** Compact derived subset for list cards. */
  derived?: Partial<DerivedRunState> & { runId?: string };
  writtenAt: number;
}

export const DEBUG_META_FILENAME = "debug.meta.json";

/** Write or refresh logs/<runId>/debug.meta.json from an index entry. */
export async function writeDebugMetaSidecar(
  logDir: string,
  entry: Pick<PerRunDebugIndexEntry, "runId" | "bytes" | "lineCount" | "derived">,
): Promise<string> {
  const dir = path.join(logDir, entry.runId);
  await fs.mkdir(dir, { recursive: true });
  const metaPath = path.join(dir, DEBUG_META_FILENAME);
  const d = entry.derived;
  const body: DebugMetaSidecar = {
    version: 1,
    runId: entry.runId,
    startedAt: d?.startedAt,
    finishedAt: d?.finishedAt,
    preset: d?.preset,
    lineCount: entry.lineCount,
    bytes: entry.bytes,
    stopReason: d?.stopReason,
    hasSummary: d?.hasSummary,
    derived: d
      ? {
          runId: d.runId ?? entry.runId,
          preset: d.preset,
          startedAt: d.startedAt,
          finishedAt: d.finishedAt,
          durationMs: d.durationMs,
          finalPhase: d.finalPhase,
          stopReason: d.stopReason,
          hasSummary: d.hasSummary,
          transcriptCount: d.transcriptCount,
          agentCount: d.agentCount,
          anomalyFlags: d.anomalyFlags,
          errors: d.errors?.slice(0, 5),
          eventTypeCounts: d.eventTypeCounts,
        }
      : { runId: entry.runId },
    writtenAt: Date.now(),
  };
  await fs.writeFile(metaPath, JSON.stringify(body), "utf8");
  return metaPath;
}

/** Prefer fresh debug.meta.json over scanning debug.jsonl. */
export async function tryReadDebugMetaSidecar(
  logDir: string,
  runId: string,
  debugMtimeMs: number,
  debugBytes: number,
): Promise<PerRunDebugIndexEntry | null> {
  const metaPath = path.join(logDir, runId, DEBUG_META_FILENAME);
  try {
    const [metaSt, raw] = await Promise.all([
      fs.stat(metaPath),
      fs.readFile(metaPath, "utf8"),
    ]);
    // Stale if debug.jsonl is clearly newer than meta (more events landed).
    // 2s skew for Windows filesystem timestamp rounding.
    if (debugMtimeMs > metaSt.mtimeMs + 2_000) return null;
    const parsed = JSON.parse(raw) as DebugMetaSidecar;
    if (!parsed || parsed.version !== 1 || parsed.runId !== runId) return null;
    const derivedBase = parsed.derived ?? {};
    const derived: DerivedRunState = {
      errors: Array.isArray(derivedBase.errors) ? derivedBase.errors : [],
      transcriptCount: derivedBase.transcriptCount ?? 0,
      agentStateUpdates: 0,
      agentActivityEvents: 0,
      activityTimeline: [],
      hasSummary: derivedBase.hasSummary ?? parsed.hasSummary ?? false,
      phaseTimeline: [],
      eventTypeCounts: derivedBase.eventTypeCounts ?? {},
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
      anomalyFlags: Array.isArray(derivedBase.anomalyFlags) ? derivedBase.anomalyFlags : [],
      runId: derivedBase.runId ?? runId,
      preset: derivedBase.preset ?? parsed.preset,
      startedAt: derivedBase.startedAt ?? parsed.startedAt,
      finishedAt: derivedBase.finishedAt ?? parsed.finishedAt,
      durationMs: derivedBase.durationMs,
      finalPhase: derivedBase.finalPhase,
      stopReason: derivedBase.stopReason ?? parsed.stopReason,
      agentCount: derivedBase.agentCount,
    };
    return {
      runId,
      bytes: parsed.bytes || debugBytes,
      mtimeMs: metaSt.mtimeMs,
      lineCount: parsed.lineCount ?? 0,
      derived,
      fromMeta: true,
    };
  } catch {
    return null;
  }
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

/** List rotated debug segments for a run dir (debug-*.jsonl / .gz), oldest first. */
export async function listRotatedDebugSegments(
  runDir: string,
): Promise<Array<{ name: string; path: string; size: number; mtimeMs: number }>> {
  let names: string[] = [];
  try {
    names = await fs.readdir(runDir);
  } catch {
    return [];
  }
  const segs: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!/^debug-.+\.jsonl(\.gz)?$/i.test(name)) continue;
    const p = path.join(runDir, name);
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) continue;
      segs.push({ name, path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  segs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return segs.slice(-PER_RUN_ROTATED_ARCHIVE_LIMIT);
}

async function indexOnePerRunDebugLog(
  logDir: string,
  runId: string,
): Promise<PerRunDebugIndexEntry | null> {
  const runDir = path.join(logDir, runId);
  const debugPath = path.join(runDir, "debug.jsonl");
  try {
    const st = await fs.stat(debugPath);
    const rotated = await listRotatedDebugSegments(runDir);
    const rotatedBytes = rotated.reduce((s, r) => s + r.size, 0);
    const totalBytes = st.size + rotatedBytes;

    // PR1: prefer sidecar when fresh (avoids scanning multi-MB debug.jsonl).
    const fromMeta = await tryReadDebugMetaSidecar(logDir, runId, st.mtimeMs, totalBytes);
    if (fromMeta && fromMeta.lineCount > 0) {
      return { ...fromMeta, bytes: Math.max(fromMeta.bytes, totalBytes) };
    }

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
      // PR4: account for rotated archives in lineCount (estimate by streaming metrics
      // would be expensive; add gzip/jsonl line counts for small archives only).
      for (const seg of rotated) {
        if (seg.size > PER_RUN_INDEX_FULL_READ_MAX_BYTES) {
          // Cheap estimate: ~200 bytes/line average for JSONL events
          lineCount += Math.max(1, Math.floor(seg.size / 200));
          continue;
        }
        try {
          const buf = await fs.readFile(seg.path);
          const text = seg.name.endsWith(".gz")
            ? zlib.gunzipSync(buf).toString("utf8")
            : buf.toString("utf8");
          const n = text.split("\n").filter((l) => l.trim().length > 0).length;
          lineCount += n;
        } catch {
          lineCount += Math.max(1, Math.floor(seg.size / 200));
        }
      }
    } catch {
      lineCount = 0;
    }
    const entry: PerRunDebugIndexEntry = {
      runId,
      bytes: totalBytes,
      mtimeMs: st.mtimeMs,
      lineCount,
      derived,
    };
    // Best-effort write sidecar for next list (completed runs with summary).
    if (derived?.hasSummary || derived?.finishedAt) {
      void writeDebugMetaSidecar(logDir, entry).catch(() => {});
    }
    return entry;
  } catch {
    // No current debug.jsonl — try rotated-only (run fully archived).
    try {
      const rotated = await listRotatedDebugSegments(runDir);
      if (rotated.length === 0) return null;
      const last = rotated[rotated.length - 1]!;
      return {
        runId,
        bytes: rotated.reduce((s, r) => s + r.size, 0),
        mtimeMs: last.mtimeMs,
        lineCount: Math.max(1, Math.floor(rotated.reduce((s, r) => s + r.size, 0) / 200)),
        derived: {
          runId,
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
          anomalyFlags: ["rotated-only"],
          finalPhase: "archived",
        },
      };
    } catch {
      return null;
    }
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

  // PR3: persistent event-log-index.json — skip rescan when mtime matches.
  const {
    loadEventLogIndex,
    saveEventLogIndex,
    entryFromIndex,
    upsertIndexEntry,
  } = await import("./eventLogIndex.js");
  const diskIndex = await loadEventLogIndex(logDir);
  let indexDirty = false;

  const indexed = await Promise.all(
    runIds.map(async (id) => {
      const debugPath = path.join(logDir, id, "debug.jsonl");
      try {
        const st = await fs.stat(debugPath);
        const cached = diskIndex.perRun[id];
        if (cached && Math.abs(cached.mtimeMs - st.mtimeMs) < 2_000 && cached.lineCount > 0) {
          return entryFromIndex(cached);
        }
      } catch {
        /* fall through to full index */
      }
      const entry = await indexOnePerRunDebugLog(logDir, id);
      if (entry) {
        upsertIndexEntry(diskIndex, entry);
        indexDirty = true;
      }
      return entry;
    }),
  );

  // Drop index rows for deleted run dirs
  const live = new Set(runIds);
  for (const id of Object.keys(diskIndex.perRun)) {
    if (!live.has(id)) {
      delete diskIndex.perRun[id];
      indexDirty = true;
    }
  }
  if (indexDirty) {
    try {
      await saveEventLogIndex(logDir, diskIndex);
    } catch {
      /* best effort */
    }
  }

  return indexed.filter((e): e is PerRunDebugIndexEntry => e != null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readPerRunDebugLog(
  logDir: string,
  runId: string,
): Promise<{ records: LoggedRecord[]; malformed: ReadAllEventLogsResult["malformed"]; path: string } | null> {
  const runDir = path.join(logDir, runId);
  const debugPath = path.join(runDir, "debug.jsonl");
  const rotated = await listRotatedDebugSegments(runDir);

  // PR4: merge oldest rotated → newest, then current debug.jsonl, with byte budget
  // (prefer the end of the run for timeline usefulness).
  const parts: Array<{ path: string; size: number }> = [
    ...rotated.map((r) => ({ path: r.path, size: r.size })),
  ];
  try {
    const st = await fs.stat(debugPath);
    parts.push({ path: debugPath, size: st.size });
  } catch {
    /* current may be missing after full rotation */
  }
  if (parts.length === 0) return null;

  let budget = PER_RUN_REPLAY_MAX_BYTES;
  const selected: Array<{ path: string; size: number }> = [];
  // Walk newest → oldest so we keep the tail under budget.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (budget <= 0) break;
    if (p.size > budget && selected.length > 0) break;
    selected.unshift(p);
    budget -= p.size;
  }

  const allRecords: LoggedRecord[] = [];
  const allMalformed: ReadAllEventLogsResult["malformed"] = [];
  for (const part of selected) {
    try {
      const buf = await fs.readFile(part.path);
      const text = part.path.endsWith(".gz")
        ? zlib.gunzipSync(buf, { maxOutputLength: PER_RUN_REPLAY_MAX_BYTES }).toString("utf8")
        : buf.toString("utf8");
      const { records, malformed } = parseEventLog(text);
      allRecords.push(...records);
      allMalformed.push(...malformed);
    } catch {
      /* skip bad segment */
    }
  }
  if (allRecords.length === 0) return null;
  return {
    records: allRecords,
    malformed: allMalformed,
    path: selected.map((s) => s.path).join("|"),
  };
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

  // PR6: prefer archives-index.jsonl; only gunzip heads for unindexed archives.
  const { loadArchiveIndexHits, appendArchiveIndexHits } = await import("./eventLogIndex.js");
  const archiveIndex = await loadArchiveIndexHits(logDir);
  for (const hit of archiveIndex.values()) {
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
      } satisfies DerivedRunState,
      recordCount: 1,
      isSessionBoundary: false,
      source: "archive-index",
    });
  }

  const indexedArchiveNames = new Set(
    [...archiveIndex.values()].map((h) => h.archive),
  );
  const indexArchives = archives
    .slice(-ARCHIVE_INDEX_LIMIT)
    .filter((name) => !indexedArchiveNames.has(name));
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
        const hits = parseArchiveRunStartedLines(text);
        if (hits.length > 0) {
          void appendArchiveIndexHits(
            logDir,
            hits.map((h) => ({
              archive: name,
              runId: h.runId,
              startedAt: h.startedAt,
              preset: h.preset,
            })),
          ).catch(() => {});
        }
        return hits;
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
        recordCount: 1,
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
    archivesIndexed: indexedArchiveNames.size + indexArchives.length,
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