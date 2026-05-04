// R8 (2026-05-04): tests for cross-process clone lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import {
  parseLockFile,
  classifyLock,
  tryAcquireLock,
  releaseLock,
  defaultIsPidAlive,
  LOCK_FILE_NAME,
} from "./cloneLock.js";

function tmpCloneDir(): string {
  return mkdtempSync(path.join(tmpdir(), "lock-test-"));
}

test("parseLockFile — well-formed → LockInfo", () => {
  const got = parseLockFile(
    JSON.stringify({
      pid: 1234,
      runId: "run-1",
      startedAt: 1_700_000_000_000,
      hostname: "host-a",
    }),
  );
  assert.deepEqual(got, {
    pid: 1234,
    runId: "run-1",
    startedAt: 1_700_000_000_000,
    hostname: "host-a",
  });
});

test("parseLockFile — missing field → null", () => {
  const got = parseLockFile(
    JSON.stringify({ pid: 1, runId: "x", startedAt: 1 }),
  );
  assert.equal(got, null);
});

test("parseLockFile — non-JSON → null", () => {
  assert.equal(parseLockFile("not json"), null);
});

test("classifyLock — different hostname → live (don't reclaim cross-host)", () => {
  const got = classifyLock({
    lock: { pid: 1, runId: "x", startedAt: 1, hostname: "other-host" },
    isPidAlive: () => false,
    currentHostname: "this-host",
  });
  assert.equal(got.kind, "live");
});

test("classifyLock — same host, pid alive → live", () => {
  const got = classifyLock({
    lock: { pid: 1234, runId: "x", startedAt: 1, hostname: "h" },
    isPidAlive: () => true,
    currentHostname: "h",
  });
  assert.equal(got.kind, "live");
});

test("classifyLock — same host, pid dead → stale", () => {
  const got = classifyLock({
    lock: { pid: 1234, runId: "x", startedAt: 1, hostname: "h" },
    isPidAlive: () => false,
    currentHostname: "h",
  });
  assert.equal(got.kind, "stale");
});

test("defaultIsPidAlive — own pid → true", () => {
  assert.equal(defaultIsPidAlive(process.pid), true);
});

test("defaultIsPidAlive — pid 0 → false", () => {
  assert.equal(defaultIsPidAlive(0), false);
});

test("defaultIsPidAlive — clearly nonexistent pid → false", () => {
  // Pick a high number unlikely to be live.
  assert.equal(defaultIsPidAlive(9_999_999), false);
});

test("tryAcquireLock — fresh dir → acquired", () => {
  const dir = tmpCloneDir();
  try {
    const got = tryAcquireLock({ clonePath: dir, runId: "run-1" });
    assert.equal(got.acquired, true);
    assert.ok(existsSync(path.join(dir, LOCK_FILE_NAME)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireLock — second call from same process → blocked (pid is alive)", () => {
  const dir = tmpCloneDir();
  try {
    const first = tryAcquireLock({ clonePath: dir, runId: "run-a" });
    assert.equal(first.acquired, true);
    const second = tryAcquireLock({
      clonePath: dir,
      runId: "run-b",
      isPidAlive: () => true,
    });
    assert.equal(second.acquired, false);
    assert.equal(second.heldBy?.runId, "run-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireLock — stale lock (pid dead) → reclaimed", () => {
  const dir = tmpCloneDir();
  try {
    // Plant a stale lock owned by a "dead" pid.
    writeFileSync(
      path.join(dir, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 9_999_999,
        runId: "old-run",
        startedAt: Date.now() - 1_000_000,
        hostname: os.hostname(),
      }),
    );
    const got = tryAcquireLock({
      clonePath: dir,
      runId: "new-run",
      isPidAlive: () => false,
    });
    assert.equal(got.acquired, true);
    const raw = readFileSync(path.join(dir, LOCK_FILE_NAME), "utf8");
    const parsed = parseLockFile(raw);
    assert.equal(parsed?.runId, "new-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireLock — cross-host lock NOT reclaimed even if pid 'dead'", () => {
  const dir = tmpCloneDir();
  try {
    writeFileSync(
      path.join(dir, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 1,
        runId: "remote-run",
        startedAt: Date.now() - 1000,
        hostname: "some-other-host",
      }),
    );
    const got = tryAcquireLock({
      clonePath: dir,
      runId: "local-run",
      isPidAlive: () => false,
    });
    assert.equal(got.acquired, false);
    assert.equal(got.heldBy?.hostname, "some-other-host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireLock — garbage lock contents → reclaimed", () => {
  const dir = tmpCloneDir();
  try {
    writeFileSync(path.join(dir, LOCK_FILE_NAME), "not json at all");
    const got = tryAcquireLock({
      clonePath: dir,
      runId: "fresh",
      isPidAlive: () => true, // doesn't matter, lock is unparseable
    });
    assert.equal(got.acquired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLock — owner releases successfully", () => {
  const dir = tmpCloneDir();
  try {
    const got = tryAcquireLock({ clonePath: dir, runId: "run-1" });
    assert.equal(got.acquired, true);
    const rel = releaseLock({ clonePath: dir, runId: "run-1" });
    assert.equal(rel.released, true);
    assert.equal(existsSync(path.join(dir, LOCK_FILE_NAME)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLock — refuses to delete foreign lock", () => {
  const dir = tmpCloneDir();
  try {
    writeFileSync(
      path.join(dir, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 99999,
        runId: "other-run",
        startedAt: Date.now(),
        hostname: os.hostname(),
      }),
    );
    const rel = releaseLock({ clonePath: dir, runId: "our-run" });
    assert.equal(rel.released, false);
    assert.equal(existsSync(path.join(dir, LOCK_FILE_NAME)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLock — no lock file → no-op", () => {
  const dir = tmpCloneDir();
  try {
    const rel = releaseLock({ clonePath: dir, runId: "x" });
    assert.equal(rel.released, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
