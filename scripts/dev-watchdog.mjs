#!/usr/bin/env node
/**
 * Parent-death reaper for `npm run dev`.
 *
 * Why this exists:
 * On Windows, Ctrl+C / closing the terminal / npm dying often kills the
 * `dev.mjs` parent WITHOUT running its async shutdown handlers. tsx + vite
 * children then keep LISTENING on 8243/8244 (and the Ollama proxy port).
 * The next `npm run dev` needs kill-port bandaids.
 *
 * This process is started detached. It only acts when the parent PID is gone:
 * tree-kill any still-tracked children and free LISTENING sockets on the
 * configured ports. Clean shutdown of dev.mjs kills this watchdog first so it
 * does not race a graceful stop.
 *
 * Usage: node scripts/dev-watchdog.mjs <parentPid> <port,port,...> [childPidFile]
 */
import fs from "node:fs";
import { freePortsSync, killPidTree } from "./lib/freePort.mjs";

const parentPid = Number.parseInt(process.argv[2] ?? "", 10);
const ports = String(process.argv[3] ?? "")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0);
const childPidFile = process.argv[4] || "";

if (!Number.isInteger(parentPid) || parentPid <= 0) {
  process.exit(2);
}

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readChildPids() {
  if (!childPidFile) return [];
  try {
    const raw = fs.readFileSync(childPidFile, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== parentPid);
  } catch {
    return [];
  }
}

function reap() {
  // Prefer killing known children first (covers cases where port ownership
  // races or netstat is briefly empty after a partial crash).
  for (const pid of readChildPids()) {
    killPidTree(pid);
  }
  if (ports.length > 0) {
    freePortsSync(ports, { retries: 4, delayMs: 150 });
  }
  try {
    if (childPidFile && fs.existsSync(childPidFile)) fs.unlinkSync(childPidFile);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// Clean stop from parent — do not free ports (parent owns cleanup).
for (const sig of ["SIGTERM", "SIGINT", "SIGBREAK"]) {
  try {
    process.on(sig, () => process.exit(0));
  } catch {
    /* SIGBREAK may be missing on POSIX */
  }
}

if (!parentAlive()) {
  reap();
}

const timer = setInterval(() => {
  if (!parentAlive()) {
    clearInterval(timer);
    reap();
  }
}, 400);

// Keep the event loop alive.
timer.unref?.();
// re-ref so we actually stay alive when detached
if (typeof timer.ref === "function") timer.ref();
