// R8 (2026-05-04): cross-process clone lock.
//
// If two server processes pick the same clone path (e.g. user starts a
// run in tab A, kills the dev server, restarts it, starts a new run in
// tab B against the same path before A's children have died) the swarms
// step on each other's git state. Drop a `.lock` next to the clone
// containing { pid, runId, startedAt, hostname }.
//
// On run-start: try to acquire — if a lock exists, check whether its
// PID is still alive. Dead PID → stale, take it. Live PID → fail.
//
// I/O lives at the bottom (acquire/release); the staleness decision is
// a pure helper that takes an injected `isPidAlive` so tests can drive
// every branch deterministically.

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

export const LOCK_FILE_NAME = ".lock";

export interface LockInfo {
  pid: number;
  runId: string;
  startedAt: number;
  hostname: string;
}

/** Parse lock-file contents. Returns null on malformed or missing
 *  fields. */
export function parseLockFile(contents: string): LockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.runId !== "string" ||
    typeof obj.startedAt !== "number" ||
    typeof obj.hostname !== "string"
  ) {
    return null;
  }
  return {
    pid: obj.pid,
    runId: obj.runId,
    startedAt: obj.startedAt,
    hostname: obj.hostname,
  };
}

export type LockStatus =
  | { kind: "stale"; reason: string }
  | { kind: "live"; reason: string };

/** Pure decision: given an existing lock + a way to check if its PID
 *  is alive, decide whether the lock should be considered stale (and
 *  therefore reclaimable). */
export function classifyLock(input: {
  lock: LockInfo;
  isPidAlive: (pid: number) => boolean;
  /** Same-host check — a lock from a different machine is treated as
   *  live regardless of the local PID table. */
  currentHostname: string;
}): LockStatus {
  const { lock, isPidAlive, currentHostname } = input;
  if (lock.hostname !== currentHostname) {
    return {
      kind: "live",
      reason: `lock owned by host ${lock.hostname} (we are ${currentHostname})`,
    };
  }
  if (isPidAlive(lock.pid)) {
    return {
      kind: "live",
      reason: `pid ${lock.pid} still running`,
    };
  }
  return {
    kind: "stale",
    reason: `pid ${lock.pid} no longer alive on this host`,
  };
}

export interface AcquireResult {
  acquired: boolean;
  /** When acquired=false, the existing live lock that blocks us. */
  heldBy?: LockInfo;
  /** Diagnostic / log message. */
  reason: string;
}

/** Walk known parent directories and remove any clone lock files whose
 *  PID is no longer alive. Called at server startup to prevent stale
 *  locks left by killed/crashed processes from blocking new runs.
 *  Returns the number of stale locks reclaimed. */
export function reclaimStaleLocks(parentPaths: string[], isPidAlive: (pid: number) => boolean = defaultIsPidAlive): number {
  let reclaimed = 0;
  for (const parent of parentPaths) {
    try {
      const entries = readdirSync(parent);
      for (const entry of entries) {
        if (!entry.endsWith(LOCK_FILE_NAME)) continue;
        const lockPath = path.join(parent, entry);
        let raw: string;
        try { raw = readFileSync(lockPath, "utf8"); } catch { continue; }
        const existing = parseLockFile(raw);
        if (!existing) {
          try { unlinkSync(lockPath); reclaimed++; } catch { /* ignore */ }
          continue;
        }
        const status = classifyLock({ lock: existing, isPidAlive, currentHostname: os.hostname() });
        if (status.kind === "stale") {
          try { unlinkSync(lockPath); reclaimed++; } catch { /* ignore */ }
        }
      }
    } catch {
      // parent dir doesn't exist or is unreadable — skip
    }
  }
  return reclaimed;
}

/** Default PID-liveness check using `process.kill(pid, 0)`. Returns
 *  true if signalling the process succeeds, false if it ESRCH's. */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM = process exists but we lack permission to signal it.
    // Treat as alive — better safe than reclaiming a foreign PID.
    if (code === "EPERM") return true;
    return false;
  }
}

/** Attempt to acquire the lock at <clonePath>.lock (sibling file).
 *  Atomic on POSIX + Windows: writeFileSync with `wx` flag fails if
 *  file exists. If a prior lock exists but is stale, we delete it and
 *  retry.
 *
 *  2026-05-04 fix: lock moved from <clonePath>/.lock to
 *  <clonePath>.lock (sibling). The in-clone path made the directory
 *  "non-empty" before RepoService.clone could run, which made the
 *  clone preflight reject every fresh start. Sibling-file is invisible
 *  to clone preflights + still bound to the same logical clonePath. */
export function tryAcquireLock(input: {
  clonePath: string;
  runId: string;
  isPidAlive?: (pid: number) => boolean;
}): AcquireResult {
  const { clonePath, runId, isPidAlive = defaultIsPidAlive } = input;
  const lockPath = `${clonePath}${LOCK_FILE_NAME.startsWith(".") ? "" : "."}${LOCK_FILE_NAME}`;
  const ourLock: LockInfo = {
    pid: process.pid,
    runId,
    startedAt: Date.now(),
    hostname: os.hostname(),
  };
  // Make sure the PARENT directory exists (the lock lives next to the
  // clone path, not inside it). Don't create clonePath itself —
  // RepoService.clone needs to see it as missing-or-empty.
  try {
    mkdirSync(path.dirname(clonePath), { recursive: true });
  } catch {
    /* the writeFile below will fail with a useful error */
  }
  // Fast path: try to write with `wx` (fail if exists).
  try {
    writeFileSync(lockPath, JSON.stringify(ourLock, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return { acquired: true, reason: "lock acquired" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return {
        acquired: false,
        reason: `lock write failed: ${(err as Error).message}`,
      };
    }
  }
  // Lock exists — read + classify.
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return {
      acquired: false,
      reason: "lock file existed but couldn't be read",
    };
  }
  const existing = parseLockFile(raw);
  if (!existing) {
    // Garbage on disk — reclaim.
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return tryAcquireLock({ clonePath, runId, isPidAlive });
  }
  const status = classifyLock({
    lock: existing,
    isPidAlive,
    currentHostname: os.hostname(),
  });
  if (status.kind === "live") {
    return { acquired: false, heldBy: existing, reason: status.reason };
  }
  // Stale — reclaim.
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
  return tryAcquireLock({ clonePath, runId, isPidAlive });
}

/** Release the lock if we own it. No-op if the lock file is gone or
 *  belongs to someone else (defensive — never delete a foreign lock). */
export function releaseLock(input: {
  clonePath: string;
  runId: string;
}): { released: boolean; reason: string } {
  const { clonePath, runId } = input;
  // 2026-05-04 fix: lock is now <clonePath>.lock (sibling), not inside.
  const lockPath = `${clonePath}${LOCK_FILE_NAME.startsWith(".") ? "" : "."}${LOCK_FILE_NAME}`;
  if (!existsSync(lockPath)) {
    return { released: false, reason: "no lock file present" };
  }
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return { released: false, reason: "lock unreadable" };
  }
  const existing = parseLockFile(raw);
  if (!existing) {
    // Garbage; safe to remove.
    try {
      unlinkSync(lockPath);
      return { released: true, reason: "removed unparseable lock" };
    } catch {
      return { released: false, reason: "failed to unlink" };
    }
  }
  if (existing.runId !== runId || existing.pid !== process.pid) {
    return {
      released: false,
      reason: `lock belongs to runId=${existing.runId} pid=${existing.pid} — refusing to delete`,
    };
  }
  try {
    unlinkSync(lockPath);
    return { released: true, reason: "lock released" };
  } catch (err) {
    return {
      released: false,
      reason: `unlink failed: ${(err as Error).message}`,
    };
  }
}
