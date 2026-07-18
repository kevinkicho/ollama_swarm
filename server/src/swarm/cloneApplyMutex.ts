/**
 * Per-clone apply/commit serialization.
 *
 * Parallel workers on the same clone race at:
 *   read → transform → write → git add -A → commit
 * Without a lock, two non-overlapping expectedFiles todos can still
 * interleave writes and produce a lost commit or dirty-tree conflict.
 *
 * This is structural isolation (one critical section per clone path),
 * not an agent-behavior cap. Different clones run fully in parallel.
 */

import path from "node:path";

/** Normalize so `C:\a` and `c:/a` share a lock on Windows. */
export function normalizeCloneLockKey(clonePath: string): string {
  const resolved = path.resolve(clonePath.trim());
  // path.resolve already collapses . / ..; lower-case for case-insensitive FS.
  return process.platform === "win32"
    ? resolved.replace(/\\/g, "/").toLowerCase()
    : resolved.replace(/\\/g, "/");
}

/** Metadata passed into the critical section after the lock is held. */
export interface CloneApplyLockMeta {
  /**
   * True when another apply/commit held the lock when we arrived
   * (we waited for them to finish before re-reading the tree).
   */
  contended: boolean;
  /** Wall-clock ms spent waiting for the prior holder (0 if uncontended). */
  waitedMs: number;
}

/** Tail of the queue per clone key (resolves when last critical section ends). */
const queueTails = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusive of other withCloneApplyLock callers for the same clone.
 * When `clonePath` is empty/undefined (unit tests with in-memory fakes),
 * runs immediately with no locking (meta.contended=false).
 */
export async function withCloneApplyLock<T>(
  clonePath: string | null | undefined,
  fn: (meta: CloneApplyLockMeta) => Promise<T>,
): Promise<T> {
  const raw = clonePath?.trim();
  if (!raw) {
    return fn({ contended: false, waitedMs: 0 });
  }
  const key = normalizeCloneLockKey(raw);
  const prev = queueTails.get(key) ?? Promise.resolve();
  const contended = queueTails.has(key);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain: next waiter awaits our gate; we await prev then run fn.
  const ourTail = prev.then(
    () => gate,
    () => gate,
  );
  queueTails.set(key, ourTail);

  const waitStarted = Date.now();
  await prev.catch(() => {
    /* prior failure must not block us */
  });
  const waitedMs = contended ? Math.max(0, Date.now() - waitStarted) : 0;

  try {
    return await fn({ contended, waitedMs });
  } finally {
    release();
    // Drop map entry when we are still the tip (no waiter extended the chain).
    if (queueTails.get(key) === ourTail) {
      queueTails.delete(key);
    }
  }
}

/** Test helper: how many clone keys currently hold a queue tail. */
export function cloneApplyLockActiveKeys(): number {
  return queueTails.size;
}

/** Test helper: clear all locks (only for unit tests). */
export function resetCloneApplyLocksForTests(): void {
  queueTails.clear();
}
