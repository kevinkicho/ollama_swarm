import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentPidTracker } from "./agentPids.js";

async function freshRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pids-"));
  return dir;
}

describe("AgentPidTracker — add + readAll round trip", () => {
  it("writes and reads back a single record", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1000, pid: 42, port: 55555, cwd: "/tmp/clone" });
      const all = await t.readAll();
      assert.equal(all.length, 1);
      assert.deepEqual(all[0], {
        spawnedAt: 1000,
        pid: 42,
        port: 55555,
        cwd: "/tmp/clone",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("appends multiple records without clobbering", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1000, pid: 1, port: 1001, cwd: "/a" });
      await t.add({ spawnedAt: 2000, pid: 2, port: 1002, cwd: "/b" });
      await t.add({ spawnedAt: 3000, pid: 3, port: 1003, cwd: "/c" });
      const all = await t.readAll();
      assert.equal(all.length, 3);
      assert.deepEqual(
        all.map((e) => e.pid),
        [1, 2, 3],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves cwd paths that contain spaces (Windows-style)", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({
        spawnedAt: 1000,
        pid: 42,
        port: 55555,
        cwd: "C:\\Users\\Kevin Dev\\project folder\\clone",
      });
      const all = await t.readAll();
      assert.equal(all[0]!.cwd, "C:\\Users\\Kevin Dev\\project folder\\clone");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates the logs/ parent dir on first add", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1, pid: 1, port: 1, cwd: "/x" });
      const stat = await fs.stat(path.join(root, "logs"));
      assert.ok(stat.isDirectory(), "logs/ should exist after first add");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty array when the log file doesn't exist yet", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      const all = await t.readAll();
      assert.deepEqual(all, []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("AgentPidTracker — remove", () => {
  it("removes only the matching PID, keeps the others", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1, pid: 1, port: 1, cwd: "/a" });
      await t.add({ spawnedAt: 2, pid: 2, port: 2, cwd: "/b" });
      await t.add({ spawnedAt: 3, pid: 3, port: 3, cwd: "/c" });
      await t.remove(2);
      const all = await t.readAll();
      assert.equal(all.length, 2);
      assert.deepEqual(
        all.map((e) => e.pid).sort(),
        [1, 3],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deletes the file when all records are removed", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1, pid: 99, port: 1, cwd: "/a" });
      await t.remove(99);
      await assert.rejects(fs.stat(t.filePath));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the log file doesn't exist", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.remove(42); // must not throw
      const all = await t.readAll();
      assert.deepEqual(all, []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the PID isn't in the log", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1, pid: 1, port: 1, cwd: "/a" });
      await t.remove(999);
      const all = await t.readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.pid, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("AgentPidTracker — malformed line handling", () => {
  it("skips malformed lines without crashing", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await fs.mkdir(path.dirname(t.filePath), { recursive: true });
      // Mix of good + bad lines — only the good one should survive.
      await fs.writeFile(
        t.filePath,
        [
          "1000 42 55555 /tmp/clone",
          "not-a-valid-line",
          "",
          "abc 42 bad /tmp/bad",
          "2000 43 55556 /tmp/clone2",
          "2000 notapid 55557 /tmp/clone3",
        ].join("\n") + "\n",
        "utf8",
      );
      const all = await t.readAll();
      assert.equal(all.length, 2);
      assert.deepEqual(
        all.map((e) => e.pid).sort(),
        [42, 43],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("AgentPidTracker — clear", () => {
  it("deletes the log file", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.add({ spawnedAt: 1, pid: 1, port: 1, cwd: "/a" });
      await t.clear();
      await assert.rejects(fs.stat(t.filePath));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the file doesn't exist", async () => {
    const root = await freshRepo();
    try {
      const t = new AgentPidTracker(root);
      await t.clear(); // must not throw
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
