import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeWorkingTreeProposal,
  isWorkingTreeProposal,
  workingTreeFilesFromHunks,
  workingTreeMessageFromHunks,
  commitWorkingTreeFiles,
  WORKING_TREE_MARKER_OP,
} from "./workingTreeCommit.js";
import type { FilesystemAdapter, GitAdapter } from "./WorkerPipeline.js";

describe("workingTreeCommit", () => {
  it("makeWorkingTreeProposal builds marker hunks", () => {
    const p = makeWorkingTreeProposal(["src/a.ts", "src/b.ts"], "fix thing");
    assert.equal(p.files.length, 2);
    assert.equal(p.hunks[0]!.op, WORKING_TREE_MARKER_OP);
    assert.deepEqual(p.hunks[0]!.files, ["src/a.ts", "src/b.ts"]);
    assert.equal(p.hunks[0]!.message, "fix thing");
  });

  it("isWorkingTreeProposal detects marker", () => {
    assert.equal(isWorkingTreeProposal([{ op: "working_tree", file: "a.ts", files: ["a.ts"], message: "m" }]), true);
    assert.equal(isWorkingTreeProposal([{ op: "replace", file: "a.ts", search: "x", replace: "y" }]), false);
    assert.equal(isWorkingTreeProposal([]), false);
  });

  it("extracts files and message from marker", () => {
    const hunks = makeWorkingTreeProposal(["x.ts"], "hello").hunks;
    assert.deepEqual(workingTreeFilesFromHunks(hunks, ["fallback"]), ["x.ts"]);
    assert.equal(workingTreeMessageFromHunks(hunks, "fb"), "hello");
  });

  it("commitWorkingTreeFiles stages readable files and commits", async () => {
    const store = new Map<string, string>([["a.ts", "export const a = 1;\n"]]);
    const fs: FilesystemAdapter = {
      async read(p) {
        return store.has(p) ? store.get(p)! : null;
      },
      async write(p, c) {
        store.set(p, c);
      },
    };
    let committed = false;
    const git: GitAdapter = {
      async commitAll(message) {
        committed = true;
        assert.match(message, /fix/);
        return { ok: true, sha: "abc1234deadbeef" };
      },
    };
    const r = await commitWorkingTreeFiles({
      todoId: "t1",
      workerId: "w1",
      files: ["a.ts", "missing.ts"],
      message: "fix a",
      fs,
      git,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.filesWritten, ["a.ts"]);
      assert.equal(r.commitSha, "abc1234deadbeef");
    }
    assert.equal(committed, true);
  });

  it("commitWorkingTreeFiles fails when no files exist", async () => {
    const fs: FilesystemAdapter = {
      async read() {
        return null;
      },
      async write() {},
    };
    const git: GitAdapter = {
      async commitAll() {
        return { ok: true, sha: "x" };
      },
    };
    const r = await commitWorkingTreeFiles({
      todoId: "t1",
      workerId: "w1",
      files: ["gone.ts"],
      message: "m",
      fs,
      git,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /none of the listed files exist/);
  });

  it("skipCommit returns success without calling git", async () => {
    const fs: FilesystemAdapter = {
      async read() {
        return "ok";
      },
      async write() {},
    };
    let gitCalls = 0;
    const git: GitAdapter = {
      async commitAll() {
        gitCalls += 1;
        return { ok: true, sha: "x" };
      },
    };
    const r = await commitWorkingTreeFiles({
      todoId: "t1",
      workerId: "w1",
      files: ["a.ts"],
      message: "m",
      fs,
      git,
      skipCommit: true,
    });
    assert.equal(r.ok, true);
    assert.equal(gitCalls, 0);
  });
});
