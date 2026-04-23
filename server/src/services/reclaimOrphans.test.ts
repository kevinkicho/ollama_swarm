// Unit 38: integration-level tests for reclaimOrphans. Spawns a real
// child process, records its PID in the tracker, runs
// reclaimOrphans, and verifies (a) the live child was killed (b) the
// log was cleared.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentPidTracker } from "./agentPids.js";
import { reclaimOrphans } from "./reclaimOrphans.js";
import { isProcessAlive } from "./treeKill.js";

async function freshRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "reclaim-orphans-"));
}

describe("reclaimOrphans", () => {
  it("reports zero when the log is empty", async () => {
    const root = await freshRepo();
    try {
      const result = await reclaimOrphans(root);
      assert.equal(result.scanned, 0);
      assert.equal(result.alive, 0);
      assert.equal(result.killed, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves dead-PID records in count but doesn't try to kill them", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      // 9_999_999 is almost certainly not alive on any CI system.
      await t.add({ spawnedAt: 1, pid: 9_999_999, port: 55555, cwd: "/tmp" });
      const result = await reclaimOrphans(root);
      assert.equal(result.scanned, 1);
      assert.equal(result.alive, 0);
      assert.equal(result.killed, 0);
      // Log should still be cleared post-reclaim — dead records aren't
      // useful for the next run.
      assert.deepEqual(await t.readAll(), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("kills a live recorded PID and clears the log", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows path exercised end-to-end; POSIX path tested here");
      return;
    }
    const root = await freshRepo();
    const child = spawn("node", ["-e", "setInterval(() => {}, 10000);"], {
      stdio: "ignore",
    });
    try {
      assert.ok(child.pid);
      const tracker = new AgentPidTracker(root);
      await tracker.add({
        spawnedAt: Date.now(),
        pid: child.pid!,
        port: 55555,
        cwd: "/tmp/mock-clone",
      });
      // Child should be alive at start.
      assert.equal(isProcessAlive(child.pid!), true);

      const result = await reclaimOrphans(root);
      assert.equal(result.scanned, 1);
      assert.equal(result.alive, 1);
      assert.equal(result.killed, 1);

      // Give SIGTERM/SIGKILL time to land + kernel to reap.
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(isProcessAlive(child.pid!), false);

      // Log should be empty / gone.
      assert.deepEqual(await tracker.readAll(), []);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
