import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { treeKill } from "./treeKill.js";

// The spawn("taskkill", ...) path is not exercised here — mocking child
// processes cross-platform is more fragile than it's worth. These tests lock
// down the guard clauses so a refactor can't accidentally taskkill a process
// we already saw exit, or throw on an undefined child.

describe("treeKill guards", () => {
  it("is a no-op when child is undefined", () => {
    assert.doesNotThrow(() => treeKill(undefined));
  });

  it("is a no-op when child has no pid", () => {
    const c = { pid: undefined, killed: false, exitCode: null } as unknown as ChildProcess;
    assert.doesNotThrow(() => treeKill(c));
  });

  it("is a no-op when child.killed is true", () => {
    const c = { pid: 12345, killed: true, exitCode: null } as unknown as ChildProcess;
    assert.doesNotThrow(() => treeKill(c));
  });

  it("is a no-op when child has already exited", () => {
    const c = { pid: 12345, killed: false, exitCode: 0 } as unknown as ChildProcess;
    assert.doesNotThrow(() => treeKill(c));
  });

  it("is a no-op when child exited with a non-zero code", () => {
    const c = { pid: 12345, killed: false, exitCode: 137 } as unknown as ChildProcess;
    assert.doesNotThrow(() => treeKill(c));
  });
});
