import fs from "node:fs";
import path from "node:path";

// Per-boot append-only log of every SwarmEvent we broadcast. The file is
// truncated on server start so the newest run is always at a stable path,
// which lets Claude (or any debug tool) read it without guessing a filename.
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

export function createEventLogger(opts: EventLoggerOpts): EventLogger {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const filename = opts.filename ?? "current.jsonl";
  const logPath = path.join(opts.logDir, filename);
  // flags: "w" truncates. If we crash mid-write the old log is already gone
  // but that's fine — we only care about the current run.
  const stream = fs.createWriteStream(logPath, { flags: "w", encoding: "utf8" });
  stream.on("error", (err) => {
    // Swallow — logging is best-effort, never the primary failure surface.
    console.error(`[eventLogger] stream error: ${err.message}`);
  });

  // Stamp the top of the file so "was this a fresh boot?" is a one-line check.
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
