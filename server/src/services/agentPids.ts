// Unit 38: persistent record of every opencode subprocess we spawn, so
// that orphans from prior dev-server instances can be reclaimed on the
// next startup.
//
// Problem this solves: before Unit 38, when the dev server crashed or
// was restarted (tsx-watch reload, Ctrl-C, test runs), the previous
// server's spawned opencode subprocesses became untracked orphans.
// They continued to hold ports and keep their Ollama sessions open.
// With ~5 runs in a session we routinely saw 15+ `node.exe` orphans.
//
// Design: a single append-only log at `<repoRoot>/logs/agent-pids.log`.
// Each line is whitespace-separated:
//
//   <spawnedAt> <pid> <port> <cwd>
//
// Writes on every successful spawn; removes on clean kill. On startup,
// `reclaimOrphans` reads the file, probes each PID with isProcessAlive,
// kills any still-alive ones via killByPid, and clears the file.
//
// Kept deliberately simple: plain text, line-oriented, append-only.
// Concurrency is OK because Node is single-threaded — appends and the
// rare remove operation serialize naturally. A half-written line
// (process killed mid-append) is ignored by the reader (malformed line
// parse → skipped).

import { promises as fs } from "node:fs";
import path from "node:path";

export interface AgentPidRecord {
  spawnedAt: number;
  pid: number;
  port: number;
  cwd: string;
}

export class AgentPidTracker {
  public readonly filePath: string;

  constructor(repoRoot: string) {
    this.filePath = path.join(repoRoot, "logs", "agent-pids.log");
  }

  /** Append a new record. Creates parent dirs if needed. Best-effort — a
   *  failure to write just loses orphan-reclamation for that PID, not a
   *  run-breaking error. */
  async add(record: AgentPidRecord): Promise<void> {
    const line = `${record.spawnedAt} ${record.pid} ${record.port} ${record.cwd}\n`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    } catch {
      // best-effort
    }
  }

  /** Remove every record matching the given PID. Rewrites the file. */
  async remove(pid: number): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const kept = content
        .split(/\r?\n/)
        .filter((line) => {
          if (!line.trim()) return false;
          const parts = line.split(/\s+/);
          return parts[1] !== String(pid);
        })
        .join("\n");
      if (kept.length > 0) {
        await fs.writeFile(this.filePath, kept + "\n", "utf8");
      } else {
        await fs.unlink(this.filePath).catch(() => {});
      }
    } catch {
      // file doesn't exist or I/O error → nothing to remove
    }
  }

  /** Read every record. Malformed lines (missing fields / non-numeric
   *  PID or port) are silently skipped. */
  async readAll(): Promise<AgentPidRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const out: AgentPidRecord[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      const spawnedAt = Number.parseInt(parts[0] ?? "", 10);
      const pid = Number.parseInt(parts[1] ?? "", 10);
      const port = Number.parseInt(parts[2] ?? "", 10);
      // cwd may contain spaces on Windows; join remaining parts.
      const cwd = parts.slice(3).join(" ");
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!Number.isInteger(port) || port <= 0) continue;
      if (!Number.isInteger(spawnedAt)) continue;
      if (!cwd) continue;
      out.push({ spawnedAt, pid, port, cwd });
    }
    return out;
  }

  /** Delete the whole log. Called after orphan reclamation so the next
   *  run starts with a clean slate. */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // already gone
    }
  }
}
