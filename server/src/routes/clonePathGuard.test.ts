import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { assertAllowedClonePath } from "./clonePathGuard.js";
import type { Orchestrator } from "../services/Orchestrator.js";

function mockOrch(overrides: {
  tracked?: string[];
  parents?: string[];
  lastParent?: string;
}): Orchestrator {
  return {
    getTrackedClonePaths: () => overrides.tracked ?? [],
    getKnownParentPaths: () => overrides.parents ?? [],
    getLastParentPath: () => overrides.lastParent,
  } as unknown as Orchestrator;
}

describe("assertAllowedClonePath", () => {
  it("allows an exact tracked clone path", () => {
    const clone = path.join(os.tmpdir(), "my-clone");
    const result = assertAllowedClonePath(mockOrch({ tracked: [clone] }), clone);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.resolved, path.resolve(clone));
  });

  it("allows a child directory under a known parent", () => {
    const parent = path.join(os.tmpdir(), "runs-parent");
    const clone = path.join(parent, "some-repo");
    const result = assertAllowedClonePath(mockOrch({ parents: [parent] }), clone);
    assert.equal(result.ok, true);
  });

  it("rejects paths outside known parents", () => {
    const result = assertAllowedClonePath(
      mockOrch({ parents: [path.join(os.tmpdir(), "allowed")] }),
      "/etc/passwd",
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 403);
  });
});