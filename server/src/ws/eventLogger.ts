import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { rootLogger } from "../services/logger.js";
import { config } from "../config.js";

// Cross-session append-only log of every SwarmEvent we broadcast.
//
// #242 (2026-04-28): switched from per-boot truncate to APPEND mode +
// best-effort size cap. The previous "truncate on start" design wiped
// the V2 event log on every dev-server restart, so the V2 EventLogPanel
// in the UI never showed cross-session history. Now: events accumulate
// across restarts; when the file exceeds MAX_BYTES (~50MB) we rotate
// it to events-<iso-date>.jsonl and start a fresh current.jsonl. Old
// rotations stay on disk for reference (gitignore'd via logs/ rule).
//
// Runtime rotation (added later) + scripts/prune-logs.mjs keep individual
// files from growing to 150MB+ and clean up ancient archives.
//
// Format: one JSON object per line, shape: { ts: number, event: SwarmEvent }.
// JSONL keeps each line independently parseable even if the stream was cut
// mid-write by a crash.

export interface EventLogger {
  log: (event: unknown) => void;
  close: () => void;
  readonly path: string;
}

export interface EventLoggerOpts {
  logDir: string;
  // Filename inside logDir. Default "current.jsonl" — the name is intentionally
  // stable so Read can always find the most recent run without scanning.
  filename?: string;
}

// Log rotation config (from env/config, with previous defaults).
const MAX_BYTES = config.LOG_MAX_BYTES;
const ROTATE_CHECK_INTERVAL = config.LOG_ROTATE_CHECK_INTERVAL;

function maybeRotate(logPath: string): string | null {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_BYTES) return null;
    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.dirname(logPath);
    const archived = path.join(dir, `events-${iso}.jsonl`);
    fs.renameSync(logPath, archived);
    // Compress rotated file (.jsonl.gz) to save space (one of the log/prune recommendations)
    const gzPath = `${archived}.gz`;
    const archiveBase = path.basename(gzPath);
    // PR6: index run_started from the plain jsonl before gzip (cheap head scan).
    void indexRotatedArchiveForRuns(dir, archived, archiveBase).catch(() => {});
    pipeline(fs.createReadStream(archived), createGzip(), fs.createWriteStream(gzPath))
      .then(() => { try { fs.unlinkSync(archived); } catch {} })
      .catch((e) => rootLogger.warn('log-gz-compress-failed', { archived, error: e?.message }));
    rootLogger.info('rotated + gzipped log', { archived: gzPath });
    return gzPath;
  } catch {
    // ENOENT (no log yet) or other → first run, no rotation needed.
    return null;
  }
}

/** Scan rotated plain jsonl head for run_started → archives-index.jsonl. */
async function indexRotatedArchiveForRuns(
  logDir: string,
  plainArchivePath: string,
  archiveName: string,
): Promise<void> {
  try {
    const { createReadStream: crs } = await import("node:fs");
    const readline = await import("node:readline");
    const { appendArchiveIndexHits } = await import(
      "../swarm/blackboard/eventLogIndex.js"
    );
    const hits: Array<{
      archive: string;
      runId: string;
      startedAt: number;
      preset?: string;
    }> = [];
    const rl = readline.createInterface({
      input: crs(plainArchivePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let bytes = 0;
    const maxBytes = 512 * 1024;
    for await (const line of rl) {
      bytes += line.length + 1;
      if (bytes > maxBytes) break;
      if (!line.includes('"run_started"')) continue;
      try {
        const parsed = JSON.parse(line) as {
          ts: number;
          event: { type: string; runId?: string; preset?: string };
        };
        if (parsed.event?.type === "run_started" && parsed.event.runId) {
          hits.push({
            archive: archiveName,
            runId: parsed.event.runId,
            startedAt: parsed.ts,
            preset: parsed.event.preset,
          });
        }
      } catch {
        /* skip */
      }
    }
    rl.close();
    if (hits.length > 0) await appendArchiveIndexHits(logDir, hits);
  } catch {
    /* best effort */
  }
}

export function createEventLogger(opts: EventLoggerOpts): EventLogger {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const filename = opts.filename ?? "current.jsonl";
  let logPath = path.join(opts.logDir, filename);
  // #242 + follow-up: rotation at startup + during long runs.
  maybeRotate(logPath);
  let stream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  stream.on("error", (err) => {
    // Swallow — logging is best-effort, never the primary failure surface.
    rootLogger.error("eventLogger stream error", { error: err.message });
  });

  // Stamp a session-started marker so consumers can tell where one
  // dev-server boot ends and the next begins. EventLogReaderV2 already
  // uses this marker as a session boundary in splitIntoRuns.
  stream.write(
    JSON.stringify({ ts: Date.now(), event: { type: "_session_started" } }) + "\n",
  );

  let closed = false;
  let writeCount = 0;

  function rotateIfNeeded() {
    if (writeCount % ROTATE_CHECK_INTERVAL !== 0) return;
    const archived = maybeRotate(logPath);
    if (archived) {
      // Reopen a fresh current.jsonl
      try { stream.end(); } catch {}
      logPath = path.join(path.dirname(logPath), filename);
      stream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf8" });
      stream.on("error", (err) => {
        rootLogger.error("eventLogger stream error", { error: err.message });
      });
      // stamp new session after rotation
      stream.write(
        JSON.stringify({ ts: Date.now(), event: { type: "_session_started", reason: "rotation" } }) + "\n",
      );
    }
  }

  return {
    get path() { return logPath; },
    log(event) {
      if (closed) return;
      try {
        stream.write(JSON.stringify({ ts: Date.now(), event }) + "\n");
        writeCount++;
        rotateIfNeeded();
      } catch {
        // best-effort: do not crash broadcast over a logger issue
      }
    },
    close() {
      if (closed) return;
      closed = true;
      stream.end();
    },
  };
}
