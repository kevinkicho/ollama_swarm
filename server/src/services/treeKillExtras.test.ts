// Unit 38: tests for killByPid + isProcessAlive. Focused on the POSIX
// path (process.kill(pid, 0) semantics) since the Windows path shells
// out to tasklist.exe which isn't available in the WSL test env. The
// Windows-specific behavior is validated end-to-end by actually
// running the dev server + smoke tests; here we just verify the POSIX
// semantics and the invalid-PID guard.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isProcessAlive, killByPid } from "./treeKill.js";

describe("isProcessAlive — invalid PIDs", () => {
  it("returns false for PID 0", () => {
    assert.equal(isProcessAlive(0), false);
  });
  it("returns false for negative PID", () => {
    assert.equal(isProcessAlive(-42), false);
  });
  it("returns false for NaN", () => {
    assert.equal(isProcessAlive(Number.NaN), false);
  });
  it("returns false for a PID that definitely doesn't exist", () => {
    // 9_999_999 is almost certainly free on any Linux system running tests.
    assert.equal(isProcessAlive(9_999_999), false);
  });
});

describe("isProcessAlive — real process", () => {
  it("returns true for a freshly-spawned live process, false after it exits", async (t) => {
    // Skip on Windows — tasklist spawn semantics differ and the tests
    // for windows are covered by the live smoke.
    if (process.platform === "win32") {
      t.skip("Windows-specific path tested end-to-end, not here");
      return;
    }
    const child = spawn("node", ["-e", "setInterval(() => {}, 10000);"], {
      stdio: "ignore",
    });
    try {
      assert.ok(child.pid, "spawned child should have a pid");
      assert.equal(isProcessAlive(child.pid!), true);
      child.kill("SIGKILL");
      // Give the kernel a moment to reap.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(isProcessAlive(child.pid!), false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  });
});

describe("killByPid — invalid PIDs don't throw", () => {
  it("handles PID 0 / negative / NaN without throwing", () => {
    killByPid(0);
    killByPid(-1);
    killByPid(Number.NaN);
  });

  it("handles a PID that doesn't exist", () => {
    killByPid(9_999_999); // must not throw
  });
});

describe("killByPid — actually terminates a live process (POSIX)", () => {
  it("SIGTERM then SIGKILL escalation", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows-specific path tested end-to-end, not here");
      return;
    }
    const child = spawn("node", ["-e", "setInterval(() => {}, 10000);"], {
      stdio: "ignore",
    });
    try {
      assert.ok(child.pid);
      assert.equal(isProcessAlive(child.pid!), true);
      killByPid(child.pid!);
      // POSIX path sends SIGTERM then SIGKILL 250ms later. Wait 600ms
      // to give SIGKILL time to land + kernel to reap.
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(isProcessAlive(child.pid!), false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  });
});
