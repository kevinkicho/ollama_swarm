import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { assertUnderWorkspaceRoots } from "./workspaceRoots.js";
import { config } from "../config.js";

describe("assertUnderWorkspaceRoots", () => {
  it("allows any path when roots unset", () => {
    const prev = config.SWARM_WORKSPACE_ROOTS;
    (config as { SWARM_WORKSPACE_ROOTS: string[] }).SWARM_WORKSPACE_ROOTS = [];
    try {
      assert.equal(assertUnderWorkspaceRoots(path.resolve("/tmp/anywhere")).ok, true);
    } finally {
      (config as { SWARM_WORKSPACE_ROOTS: string[] }).SWARM_WORKSPACE_ROOTS = prev;
    }
  });

  it("rejects paths outside configured roots", () => {
    const prev = config.SWARM_WORKSPACE_ROOTS;
    const root = path.resolve(process.cwd(), "fixtures-root-test");
    (config as { SWARM_WORKSPACE_ROOTS: string[] }).SWARM_WORKSPACE_ROOTS = [root];
    try {
      const inside = assertUnderWorkspaceRoots(path.join(root, "project-a"));
      assert.equal(inside.ok, true);
      const outside = assertUnderWorkspaceRoots(path.resolve(root, "..", "other"));
      assert.equal(outside.ok, false);
    } finally {
      (config as { SWARM_WORKSPACE_ROOTS: string[] }).SWARM_WORKSPACE_ROOTS = prev;
    }
  });
});
