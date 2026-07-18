import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  withCloneApplyLock,
  normalizeCloneLockKey,
  resetCloneApplyLocksForTests,
  cloneApplyLockActiveKeys,
} from "./cloneApplyMutex.js";

describe("cloneApplyMutex", () => {
  beforeEach(() => {
    resetCloneApplyLocksForTests();
  });

  it("normalizeCloneLockKey is stable for path separators", () => {
    const a = normalizeCloneLockKey("C:\\foo\\bar");
    const b = normalizeCloneLockKey("C:/foo/bar");
    // On Windows both collapse to the same lower-case absolute form.
    if (process.platform === "win32") {
      assert.equal(a, b);
    } else {
      assert.ok(a.length > 0 && b.length > 0);
    }
  });

  it("serializes concurrent critical sections on the same clone", async () => {
    const order: number[] = [];
    const clone = "/tmp/ollama-swarm-mutex-test-same";
    let secondMeta: { contended: boolean; waitedMs: number } | undefined;

    const slow = withCloneApplyLock(clone, async (meta) => {
      assert.equal(meta.contended, false);
      order.push(1);
      await new Promise((r) => setTimeout(r, 40));
      order.push(2);
      return "a";
    });
    const fast = withCloneApplyLock(clone, async (meta) => {
      secondMeta = meta;
      order.push(3);
      return "b";
    });

    const [ra, rb] = await Promise.all([slow, fast]);
    assert.equal(ra, "a");
    assert.equal(rb, "b");
    // Second critical section starts only after first finishes (2 before 3).
    assert.deepEqual(order, [1, 2, 3]);
    assert.ok(secondMeta);
    assert.equal(secondMeta!.contended, true);
    assert.ok(secondMeta!.waitedMs >= 20, `expected waitedMs>=20, got ${secondMeta!.waitedMs}`);
  });

  it("allows parallel critical sections on different clones", async () => {
    const started: string[] = [];
    const p1 = withCloneApplyLock("/tmp/mutex-clone-a", async () => {
      started.push("a");
      await new Promise((r) => setTimeout(r, 30));
      return 1;
    });
    const p2 = withCloneApplyLock("/tmp/mutex-clone-b", async () => {
      started.push("b");
      await new Promise((r) => setTimeout(r, 30));
      return 2;
    });
    // Both should have started before either finishes.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(started.length, 2);
    await Promise.all([p1, p2]);
  });

  it("empty clonePath skips locking", async () => {
    let ran = false;
    await withCloneApplyLock(undefined, async (meta) => {
      assert.equal(meta.contended, false);
      ran = true;
    });
    await withCloneApplyLock("", async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(cloneApplyLockActiveKeys(), 0);
  });

  it("prior rejection does not block the next waiter", async () => {
    const clone = "/tmp/ollama-swarm-mutex-fail";
    await assert.rejects(
      withCloneApplyLock(clone, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    const ok = await withCloneApplyLock(clone, async () => "recovered");
    assert.equal(ok, "recovered");
  });
});
