import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Fire-and-forget process-tree kill. On Windows `child.kill()` (or SIGTERM)
// only terminates the immediate child — for opencode agents that's the
// cmd.exe shell wrapper spawn-with-`shell:true` creates, leaving the real
// opencode.exe grandchild orphaned and still holding its port. `taskkill /T`
// walks the tree and `/F` force-terminates. On POSIX we fall back to the
// signal path, where Node's own signal forwarding is reliable.
export function treeKill(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) return;
  if (child.killed || child.exitCode !== null) return;

  if (process.platform === "win32") {
    try {
      const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      k.on("error", () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

// Unit 38: kill a process tree by PID only (no ChildProcess handle).
// Used by the orphan-reclamation path on server startup — by then the
// original ChildProcess object is long gone with the dead server
// instance, but the OS-level process it spawned may still be alive
// holding a port. On Windows uses `taskkill /PID <pid> /T /F` (same as
// treeKill); on POSIX does a two-stage SIGTERM then SIGKILL with a
// small delay between them so well-behaved processes can clean up.
// Fire-and-forget. Errors swallowed — caller should verify with
// isProcessAlive if it needs to know for sure.
export function killByPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }, 250).unref?.();
  } catch {
    /* ignore */
  }
}

// Task #122: kill whatever process currently holds a TCP port. Needed
// because opencode-ai's `.opencode serve` binary actually exec()s
// through a launcher that exits within seconds — the launcher PID
// (which AgentManager captures from `child.pid`) is dead, but a
// different long-running PID owns the port. Killing by PID misses
// the real process; killing by port catches it.
//
// POSIX: `lsof -t -iTCP:<port> -sTCP:LISTEN` returns the listening
// PID(s) — kill each via the existing two-stage SIGTERM→SIGKILL.
// Falls back to `ss -tlnp` parse if lsof isn't available.
//
// Windows: parse `netstat -ano` for the matching local port + LISTENING
// state, extract the PID column, kill via taskkill.
//
// Synchronous (spawnSync) to keep the killAll polling loop simple.
// Returns the PIDs that were targeted (so caller can verify with
// isProcessAlive); empty array means no listener was found.
export function killByPort(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return [];
  const pids = listenerPidsForPort(port);
  for (const pid of pids) killByPid(pid);
  return pids;
}

function listenerPidsForPort(port: number): number[] {
  if (process.platform === "win32") {
    try {
      const r = spawnSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      if (r.error || typeof r.stdout !== "string") return [];
      const out = new Set<number>();
      for (const line of r.stdout.split(/\r?\n/)) {
        // Format: "  TCP    0.0.0.0:43205    0.0.0.0:0    LISTENING    12345"
        const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
        if (m && Number.parseInt(m[1]!, 10) === port) {
          const pid = Number.parseInt(m[2]!, 10);
          if (Number.isInteger(pid) && pid > 0) out.add(pid);
        }
      }
      return [...out];
    } catch {
      return [];
    }
  }
  // POSIX: prefer lsof (cleaner output), fall back to ss.
  try {
    const r = spawnSync(
      "lsof",
      ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (!r.error && typeof r.stdout === "string") {
      const out = new Set<number>();
      for (const line of r.stdout.split(/\s+/)) {
        const pid = Number.parseInt(line.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) out.add(pid);
      }
      if (out.size > 0) return [...out];
    }
  } catch {
    // lsof not installed — try ss.
  }
  try {
    const r = spawnSync("ss", ["-tlnp"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (r.error || typeof r.stdout !== "string") return [];
    const out = new Set<number>();
    for (const line of r.stdout.split(/\r?\n/)) {
      // ss -tlnp lines look like:
      //   LISTEN 0  511  *:43205  *:*  users:(("node-MainThread",pid=813169,fd=22))
      // Match the port and capture the pid.
      const portM = /\*:(\d+)\b/.exec(line);
      if (!portM || Number.parseInt(portM[1]!, 10) !== port) continue;
      const pidM = /pid=(\d+)/.exec(line);
      if (pidM) {
        const pid = Number.parseInt(pidM[1]!, 10);
        if (Number.isInteger(pid) && pid > 0) out.add(pid);
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

// Unit 38: is a PID currently alive? Used post-kill to verify the
// process actually died, and by the orphan-reclamation sweep to decide
// which PIDs in the log still need killing.
//
// Windows: `tasklist /FI "PID eq <pid>" /NH` — exits 0 either way but
// prints "INFO: No tasks" when the PID isn't found. Grep for the PID
// in stdout. Synchronous (spawnSync) to keep the poll loop simple —
// this is called a handful of times per kill at most.
//
// POSIX: `process.kill(pid, 0)` — sends signal 0 which tests for
// existence without actually signalling. Throws if the process
// doesn't exist OR we can't signal it (EPERM = exists but not ours).
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      const r = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      );
      if (r.error || typeof r.stdout !== "string") return false;
      // When the PID doesn't exist: stdout contains "No tasks" or is
      // empty. When it does: the CSV row includes the PID string.
      return r.stdout.includes(`"${pid}"`) || r.stdout.includes(`,${pid},`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists, we just can't signal it. Still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
