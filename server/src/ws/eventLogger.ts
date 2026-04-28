import fs from "node:fs";
import path from "node:path";

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

// #242 (2026-04-28): rotate when current.jsonl grows past this size.
// 50 MB is generous for a JSONL log of swarm events (each line is
// ~100-500 bytes, so ~50MB ≈ 100k-500k events ≈ many runs of history).
const MAX_BYTES = 50 * 1024 * 1024;

function maybeRotate(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_BYTES) return;
    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.dirname(logPath);
    const archived = path.join(dir, `events-${iso}.jsonl`);
    fs.renameSync(logPath, archived);
  } catch {
    // ENOENT (no log yet) or other → first run, no rotation needed.
  }
}

export function createEventLogger(opts: EventLoggerOpts): EventLogger {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const filename = opts.filename ?? "current.jsonl";
  const logPath = path.join(opts.logDir, filename);
  // #242: append mode preserves cross-session history. Rotation
  // checked at startup so we don't grow unbounded over months.
  maybeRotate(logPath);
  const stream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  stream.on("error", (err) => {
    // Swallow — logging is best-effort, never the primary failure surface.
    console.error(`[eventLogger] stream error: ${err.message}`);
  });

  // Stamp a session-started marker so consumers can tell where one
  // dev-server boot ends and the next begins. EventLogReaderV2 already
  // uses this marker as a session boundary in splitIntoRuns.
  stream.write(
    JSON.stringify({ ts: Date.now(), event: { type: "_session_started" } }) + "\n",
  );

  let closed = false;
  return {
    path: logPath,
    log(event) {
      if (closed) return;
      try {
        stream.write(JSON.stringify({ ts: Date.now(), event }) + "\n");
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
