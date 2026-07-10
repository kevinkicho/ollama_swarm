/**
 * Cross-platform port cleanup for dev scripts.
 * Only targets LISTENING sockets (unlike kill-port, which also matches TIME_WAIT
 * on Windows and can TaskKill PID 0).
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

/** PIDs with a TCP listener on `port` (LISTEN state only). */
export function listenerPidsForPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return [];

  if (process.platform === "win32") {
    try {
      const r = spawnSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      if (r.error || typeof r.stdout !== "string") return [];
      const out = new Set();
      for (const line of r.stdout.split(/\r?\n/)) {
        // IPv4: 0.0.0.0:8243 … LISTENING 1234
        // IPv6: [::]:8243 … LISTENING 1234
        const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && Number.parseInt(m[2], 10) === port) {
          const pid = Number.parseInt(m[3], 10);
          if (Number.isInteger(pid) && pid > 0) out.add(pid);
        }
      }
      return [...out];
    } catch {
      return [];
    }
  }

  try {
    const r = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (!r.error && typeof r.stdout === "string") {
      const out = new Set();
      for (const line of r.stdout.split(/\s+/)) {
        const pid = Number.parseInt(line.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) out.add(pid);
      }
      if (out.size > 0) return [...out];
    }
  } catch {
    // fall through to ss
  }

  try {
    const r = spawnSync("ss", ["-tlnp"], { encoding: "utf8", timeout: 5_000 });
    if (r.error || typeof r.stdout !== "string") return [];
    const out = new Set();
    for (const line of r.stdout.split(/\r?\n/)) {
      // *:8243 or 0.0.0.0:8243 or [::]:8243
      const portM = /(?::|\*:)(\d+)\b/.exec(line);
      if (!portM || Number.parseInt(portM[1], 10) !== port) continue;
      if (!/\blisten\b/i.test(line)) continue;
      const pidM = /pid=(\d+)/.exec(line);
      if (pidM) {
        const pid = Number.parseInt(pidM[1], 10);
        if (Number.isInteger(pid) && pid > 0) out.add(pid);
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

export function killPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 8_000,
    });
    return r.status === 0;
  }
  try {
    // Negative PID = process group (when child was started detached with its own group).
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

/** Kill LISTENING process trees on `port`. Returns PIDs targeted. */
export function killPortListeners(port) {
  const pids = listenerPidsForPort(port);
  for (const pid of pids) killPidTree(pid);
  return pids;
}

/** True when nothing is LISTENING on `port` (bind probe, same as server startup). */
export function isPortBindable(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    probe.once("error", (err) => {
      done(err?.code !== "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => done(true));
    });
    setTimeout(() => done(false), 800);
    probe.listen(port, host);
  });
}

/**
 * Fully synchronous free — safe for process.on("exit") / watchdog.
 * Returns { freed, pidsKilled, stillBusy }.
 */
export function freePortSync(port, { retries = 5, delayMs = 200, log } = {}) {
  const pidsKilled = [];
  for (let attempt = 0; attempt < retries; attempt++) {
    const listeners = listenerPidsForPort(port);
    if (listeners.length === 0) {
      // No LISTENING owner — treat as free (TIME_WAIT is fine for re-bind with SO_REUSEADDR).
      return { freed: true, pidsKilled, stillBusy: false };
    }
    for (const pid of listeners) {
      if (!pidsKilled.includes(pid)) pidsKilled.push(pid);
      killPidTree(pid);
      if (log) log(`killed PID ${pid} on :${port}`);
    }
    // Brief spin — exit handlers can't await.
    const end = Date.now() + delayMs;
    while (Date.now() < end) {
      /* busy wait — only used on shutdown / watchdog */
    }
  }
  const stillBusy = listenerPidsForPort(port).length > 0;
  return { freed: !stillBusy, pidsKilled, stillBusy };
}

export function freePortsSync(ports, opts = {}) {
  return ports.map((port) => ({ port, ...freePortSync(port, opts) }));
}

/**
 * Free `port` with retries. Returns { freed, pidsKilled, stillBusy }.
 */
export async function freePort(port, { retries = 4, delayMs = 450, log } = {}) {
  const pidsKilled = [];
  for (let attempt = 0; attempt < retries; attempt++) {
    if (await isPortBindable(port)) {
      return { freed: true, pidsKilled, stillBusy: false };
    }
    const pids = killPortListeners(port);
    for (const pid of pids) {
      if (!pidsKilled.includes(pid)) pidsKilled.push(pid);
    }
    if (pids.length > 0 && log) {
      log(`killed PID(s) ${pids.join(", ")} on :${port}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const stillBusy = !(await isPortBindable(port));
  return { freed: !stillBusy, pidsKilled, stillBusy };
}

export async function freePorts(ports, opts = {}) {
  const results = [];
  for (const port of ports) {
    results.push({ port, ...(await freePort(port, opts)) });
  }
  return results;
}
