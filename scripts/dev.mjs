import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { freePorts, freePortsSync, isPortBindable, killPidTree } from "./lib/freePort.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const portFile = path.join(root, ".server-port");
const childPidFile = path.join(root, ".dev-child-pids");

// Fixed ports — pinned so bookmarks, scripts, and the Network tab don't need
// to chase a new port on every restart. Override with env vars if you need to.
//
// 2026-04-27: defaults moved 52243/52244 → 8243/8244. Windows reserves the
// 52199–52398 range for Hyper-V, so the previous defaults could fail with
// EACCES on most Windows hosts. 8243/8244 sit well outside any commonly
// reserved range. Verify your host's reserved ranges with
// `netsh int ipv4 show excludedportrange protocol=tcp` if EACCES recurs.
const DEFAULT_SERVER_PORT = 8243;
const DEFAULT_WEB_PORT = 8244;
const DEFAULT_OLLAMA_PROXY_PORT = 11533;

function parsePort(raw) {
  if (!raw) return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

const port = parsePort(process.env.SERVER_PORT) ?? DEFAULT_SERVER_PORT;
const webPort = parsePort(process.env.WEB_PORT) ?? DEFAULT_WEB_PORT;
// Keep .server-port in sync so vite.config.ts + server/src/config.ts resolve
// the same port even when someone skips the env var.
fs.writeFileSync(portFile, String(port), "utf8");
// Propagate to children so server/src/config.ts sees the same value we picked.
process.env.SERVER_PORT = String(port);
console.log(`[dev] backend :${port}  ·  web :${webPort}  (wrote .server-port)`);

const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const watchdogScript = path.join(here, "dev-watchdog.mjs");

for (const [label, p] of [["tsx", tsxCli], ["vite", viteCli]]) {
  if (!fs.existsSync(p)) {
    console.error(`[dev] cannot find ${label} at ${p}. Run \`npm install\` first.`);
    process.exit(1);
  }
}

// Git identity check: blackboard workers create commits. If user.name
// isn't set, commits fail with "Author identity unknown" — a cryptic
// error that wastes a worker turn. Warn early so the contributor can
// fix it before starting a run. Don't block startup — non-blackboard
// presets and local dev don't need git identity.
(function checkGitIdentity() {
  try {
    const opts = { encoding: "utf8", windowsHide: true };
    const name = (spawnSync("git", ["config", "user.name"], opts).stdout || "").trim();
    const email = (spawnSync("git", ["config", "user.email"], opts).stdout || "").trim();
    if (!name || !email) {
      console.warn(
        `[dev] git identity not configured (user.name="${name || '<unset>'}" user.email="${email || '<unset>'}").\n` +
        `  Blackboard workers create git commits — commits will fail with "Author identity unknown" unless set.\n` +
        `  Fix: git config user.name "Your Name" && git config user.email "you@example.com"\n` +
        `  Or for this repo only: git -c user.name="..." -c user.email="..." commit ...\n`
      );
    }
  } catch {
    // git not installed or not a repo — silently skip.
  }
})();

const children = [];
/** @type {import("node:child_process").ChildProcess | null} */
let watchdog = null;
let shuttingDown = false;

/** Ports this dev stack binds: backend, Vite, and in-process Ollama proxy. */
function devPorts() {
  const proxy = parsePort(process.env.OLLAMA_PROXY_PORT) ?? DEFAULT_OLLAMA_PROXY_PORT;
  const ports = [port, webPort];
  if (proxy > 0) ports.push(proxy);
  return ports;
}

function writeChildPidFile() {
  const pids = children
    .map((c) => c.child?.pid)
    .filter((p) => Number.isInteger(p) && p > 0);
  try {
    fs.writeFileSync(childPidFile, JSON.stringify(pids), "utf8");
  } catch {
    /* ignore */
  }
}

function removeChildPidFile() {
  try {
    if (fs.existsSync(childPidFile)) fs.unlinkSync(childPidFile);
  } catch {
    /* ignore */
  }
}

/**
 * Detached reaper: if this parent dies without running shutdown handlers
 * (Windows npm/PowerShell TerminateProcess is the common case), free ports
 * so the next `npm run dev` can bind without a manual kill-port bandaid.
 */
function startWatchdog() {
  try {
    writeChildPidFile();
    watchdog = spawn(
      process.execPath,
      [watchdogScript, String(process.pid), devPorts().join(","), childPidFile],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: root,
      },
    );
    watchdog.unref();
  } catch (err) {
    console.warn(`[dev] watchdog not started: ${err instanceof Error ? err.message : err}`);
  }
}

function stopWatchdog() {
  if (!watchdog || watchdog.pid == null) return;
  try {
    killPidTree(watchdog.pid);
  } catch {
    try {
      watchdog.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  watchdog = null;
}

/** Free dev ports — LISTENING-only kill + bind verification (Windows-safe). */
async function freeDevPorts(ports = devPorts(), { log = true } = {}) {
  const results = await freePorts(ports, {
    log: log ? (msg) => console.log(`[dev] ${msg}`) : undefined,
  });
  const stuck = results.filter((r) => r.stillBusy);
  if (stuck.length > 0) {
    console.warn(
      `[dev] could not free port(s) ${stuck.map((r) => `:${r.port}`).join(", ")} — close other dev terminals or run npm run dev:kill`,
    );
  }
  return results;
}

/** If a prior session left zombies, reclaim ports before spawning children. */
async function reclaimStaleDevPorts() {
  const ports = devPorts();
  const busy = [];
  for (const p of ports) {
    if (!(await isPortBindable(p))) busy.push(p);
  }
  if (busy.length === 0) return;
  console.warn(
    `[dev] port(s) ${busy.map((p) => `:${p}`).join(", ")} still in use — cleaning up stale process(es) from a prior dev session`,
  );
  await freeDevPorts(busy);
}

/**
 * On Windows, `child.kill("SIGTERM")` only terminates the direct child —
 * tsx watch's grandchild (the real server) and any nested shells keep the
 * ports. Always use synchronous taskkill /T /F so we wait for the tree to die
 * before claiming the port is free.
 */
function forceKillPidTree(pid) {
  if (!pid) return;
  killPidTree(pid);
}

function forceKillAllChildren() {
  for (const { child } of children) {
    if (child?.pid) forceKillPidTree(child.pid);
  }
}

/** Soft signal first so the server can server.close() and release :8243 cleanly. */
function softSignalChildren() {
  for (const { child } of children) {
    if (!child || child.exitCode !== null || child.killed) continue;
    try {
      if (process.platform === "win32") {
        // Node maps this to TerminateProcess on some builds; still try —
        // force path below is the reliable Windows cleanup.
        child.kill();
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
}

function waitForChildrenExit(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const alive = children.some(
        (c) => c.child && c.child.exitCode === null && !c.child.killed,
      );
      if (!alive || Date.now() - start >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(tick, 80);
    };
    tick();
  });
}

function prefix(tag, color) {
  const esc = `\x1b[${color}m[${tag}]\x1b[0m `;
  return (buf) => {
    const text = buf.toString();
    const lines = text.split(/\r?\n/);
    const trailingNewline = text.endsWith("\n");
    const nonEmpty = lines.filter((_, i) => i < lines.length - 1 || lines[i] !== "");
    return nonEmpty.map((l) => esc + l).join("\n") + (trailingNewline ? "\n" : "");
  };
}

function launch(name, cwd, args, color) {
  // Do NOT detach children — they must stay in our tree so taskkill /T and
  // the parent-death watchdog can find them. stdin ignored so Ctrl+C is
  // handled only by this supervisor (children would otherwise get a second
  // SIGINT and race our ordered shutdown).
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
    detached: false,
  });
  const tagOut = prefix(name, color);
  child.stdout.on("data", (d) => process.stdout.write(tagOut(d)));
  child.stderr.on("data", (d) => process.stderr.write(tagOut(d)));
  child.on("exit", (code, signal) => {
    writeChildPidFile();
    if (shuttingDown) return;
    // Task #44: don't cascade-shutdown the other child when one dies.
    // Previously, if the server (tsx watch) crashed, we killed vite
    // too — which caused the browser's @vite/client to spam
    // ERR_CONNECTION_REFUSED for the whole restart window. Now the
    // surviving child keeps running so the UI stays responsive while
    // the user decides whether to restart the dead one manually.
    console.log(
      `[dev] ${name} exited (code=${code} signal=${signal}). Other children left running; press Ctrl-C to stop the rest or re-run \`npm run dev\` to restart.`,
    );
  });
  children.push({ name, child });
  writeChildPidFile();
  return child;
}

/**
 * Wait until the backend TCP port is accepting connections.
 * Prevents Vite dev server + initial browser fetches from spamming
 * "http proxy error: ECONNREFUSED" while the (slower) tsx server boots.
 * Falls back after timeout so dev doesn't hang if something is wrong.
 */
async function waitForBackend(port, host = "127.0.0.1", timeoutMs = 25000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port, timeout: 800 }, () => {
          socket.end();
          resolve(true);
        });
        socket.on("error", (e) => { lastErr = e; socket.destroy(); reject(e); });
        socket.on("timeout", () => { socket.destroy(); reject(new Error("connect timeout")); });
      });
      console.log(`[dev] backend ready on :${port}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  console.warn(`[dev] backend :${port} not reachable after ~${Math.round(timeoutMs / 1000)}s (last error: ${lastErr?.message ?? "unknown"}). Starting web anyway — initial proxy requests may fail until it finishes booting.`);
}

/**
 * Ordered shutdown:
 * 1. Soft-signal children (server can close HTTP listeners → free :8243)
 * 2. Force-kill process trees (Windows: taskkill /T /F — covers tsx watch grandchildren)
 * 3. Port-based reaper for anything still LISTENING
 * 4. Stop parent-death watchdog
 * 5. Exit only after ports are verified free (or retries exhausted)
 *
 * Root cause this addresses: previously we fire-and-forget async taskkill, then
 * process.exit after 800ms while freeDevPorts was still racing. If the parent
 * was TerminateProcess'd by npm/PowerShell, no handler ran at all → orphans.
 */
async function shutdown(reason = "signal") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev] shutdown (${reason}): stopping children and freeing ports`);

  softSignalChildren();
  await waitForChildrenExit(process.platform === "win32" ? 1200 : 2000);

  forceKillAllChildren();
  // Brief OS settle after taskkill before bind probes.
  await new Promise((r) => setTimeout(r, 200));

  try {
    await freeDevPorts(devPorts(), { log: true });
  } catch {
    // Fall back to sync kill in exit path.
    freePortsSync(devPorts());
  }

  stopWatchdog();
  removeChildPidFile();
  process.exit(0);
}

function requestShutdown(signal) {
  console.log(`\n[dev] ${signal} — stopping children`);
  void shutdown(signal);
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGBREAK", () => requestShutdown("SIGBREAK"));

// Last-resort SYNCHRONOUS cleanup — process.on("exit") cannot await.
// Must still run when shuttingDown is true if children somehow survived
// (previous bug: early-return when shuttingDown skipped force-kill).
process.on("exit", () => {
  forceKillAllChildren();
  freePortsSync(devPorts());
  stopWatchdog();
  removeChildPidFile();
});

// Windows: npm/PowerShell often swallow process.on('SIGINT'). readline must be
// registered synchronously before children start — the old dynamic import()
// raced Ctrl+C during the first seconds of boot.
if (process.stdin.isTTY) {
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => requestShutdown("readline SIGINT"));
  } catch {
    // non-TTY — skip
  }
}

// 2026-04-27: --no-watch / NO_WATCH=1 disables tsx watch on the server.
// Use during long validation runs to dodge the WSL inotify SIGTERM-after-
// summary-write flake (see reference_wsl_sigterm_after_summary memory).
// Trade-off: code edits require manual restart of the dev server.
const noWatch = process.argv.includes("--no-watch") || process.env.NO_WATCH === "1";
const serverArgs = noWatch
  ? [tsxCli, "src/index.ts"]
  : [tsxCli, "watch", "src/index.ts"];
if (noWatch) console.log("[dev] server running WITHOUT tsx watch (--no-watch). Code edits won't auto-restart.");

await reclaimStaleDevPorts();
startWatchdog();
launch("server", path.join(root, "server"), serverArgs, "36");
await waitForBackend(port);
launch("web", path.join(root, "web"), [viteCli, "--port", String(webPort), "--strictPort", "--host"], "35");
writeChildPidFile();
