// V2 Step 5b tests: post-LLM worker pipeline semantics.
//
// Uses in-memory fs/git fakes so the tests are pure logic — no
// disk I/O, no real git invocations. Real adapters will live in
// Step 5c (BlackboardRunner integration).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAndCommit,
  type FilesystemAdapter,
  type GitAdapter,
} from "./WorkerPipeline.js";
import type { Hunk } from "./applyHunks.js";

interface FakeFsState {
  files: Map<string, string>;
}

function makeFakeFs(initial: Record<string, string> = {}): {
  fs: FilesystemAdapter;
  state: FakeFsState;
} {
  const state: FakeFsState = { files: new Map(Object.entries(initial)) };
  return {
    state,
    fs: {
      async read(path) {
        return state.files.has(path) ? (state.files.get(path) as string) : null;
      },
      async write(path, content) {
        state.files.set(path, content);
      },
    },
  };
}

interface FakeGitState {
  commits: Array<{ message: string; author: string; sha: string }>;
}

function makeFakeGit(opts: { failReason?: string } = {}): {
  git: GitAdapter;
  state: FakeGitState;
} {
  const state: FakeGitState = { commits: [] };
  let nextSha = 1;
  return {
    state,
    git: {
      async commitAll(message, author) {
        if (opts.failReason) return { ok: false, reason: opts.failReason };
        const sha = `sha${nextSha++}`;
        state.commits.push({ message, author, sha });
        return { ok: true, sha };
      },
    },
  };
}

describe("applyAndCommit — happy path", () => {
  it("applies a single replace hunk + commits + reports stats", async () => {
    const { fs, state: fsState } = makeFakeFs({ "a.ts": "hello world" });
    const { git, state: gitState } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "world", replace: "kevin" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.commitSha, "sha1");
    assert.deepEqual(out.filesWritten, ["a.ts"]);
    assert.equal(fsState.files.get("a.ts"), "hello kevin");
    assert.equal(gitState.commits.length, 1);
    assert.equal(gitState.commits[0].message, "worker-2: t1");
    assert.equal(gitState.commits[0].author, "worker-2");
  });

  it("create op writes a new file", async () => {
    const { fs, state: fsState } = makeFakeFs();
    const { git } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "create", file: "new.ts", content: "fresh\n" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["new.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, true);
    assert.equal(fsState.files.get("new.ts"), "fresh\n");
  });

  it("append op extends an existing file", async () => {
    const { fs, state: fsState } = makeFakeFs({ "log.txt": "line 1\n" });
    const { git } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "append", file: "log.txt", content: "line 2\n" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["log.txt"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, true);
    assert.equal(fsState.files.get("log.txt"), "line 1\nline 2\n");
  });

  it("multi-file multi-hunk: writes only changed files", async () => {
    const { fs, state: fsState } = makeFakeFs({
      "a.ts": "alpha",
      "b.ts": "beta",
      "c.ts": "gamma",
    });
    const { git, state: gitState } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "alpha", replace: "ALPHA" },
      { op: "replace", file: "c.ts", search: "gamma", replace: "GAMMA" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts", "b.ts", "c.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.filesWritten.sort(), ["a.ts", "c.ts"]);
    assert.equal(fsState.files.get("b.ts"), "beta"); // untouched
    assert.equal(gitState.commits.length, 1);
  });

  it("counts linesAdded + linesRemoved correctly", async () => {
    const { fs } = makeFakeFs({ "a.ts": "a\nb\nc\n" });
    const { git } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "a\nb\nc\n", replace: "x\ny\n" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.linesRemoved, 1); // 3 → 2 = -1
    assert.equal(out.linesAdded, 0);
  });
});

describe("applyAndCommit — failure modes", () => {
  it("applyHunks failure: search anchor not found returns failedHunkIndex", async () => {
    const { fs } = makeFakeFs({ "a.ts": "alpha" });
    const { git, state: gitState } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "MISSING", replace: "x" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.reason, /search/i);
    // No commit fired
    assert.equal(gitState.commits.length, 0);
  });

  it("write failure surfaces the error reason", async () => {
    const fs: FilesystemAdapter = {
      async read() {
        return "hello";
      },
      async write() {
        throw new Error("disk full");
      },
    };
    const { git } = makeFakeGit();
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "hello", replace: "world" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.reason, /write failed/);
    assert.match(out.reason, /disk full/);
  });

  it("read failure surfaces the error reason", async () => {
    const fs: FilesystemAdapter = {
      async read() {
        throw new Error("permission denied");
      },
      async write() {},
    };
    const { git } = makeFakeGit();
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks: [{ op: "replace", file: "a.ts", search: "x", replace: "y" }],
      fs,
      git,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.reason, /read failed/);
  });

  it("git commit failure surfaces the reason", async () => {
    const { fs } = makeFakeFs({ "a.ts": "hello" });
    const { git } = makeFakeGit({ failReason: "git index locked" });
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "hello", replace: "world" },
    ];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.reason, /git commit failed/);
    assert.match(out.reason, /git index locked/);
  });
});

describe("applyAndCommit — no-op + empty cases", () => {
  it("hunks that produce no diff result in ok with empty filesWritten + no commit", async () => {
    // Replace "x" with "x" — applyHunks succeeds but the result equals
    // the input. Pipeline elides the commit (clean tree, nothing to do).
    const { fs } = makeFakeFs({ "a.ts": "x" });
    const { git, state: gitState } = makeFakeGit();
    const hunks: Hunk[] = [{ op: "replace", file: "a.ts", search: "x", replace: "x" }];
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["a.ts"],
      hunks,
      fs,
      git,
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.commitSha, ""); // no commit fired
    assert.deepEqual(out.filesWritten, []);
    assert.equal(gitState.commits.length, 0);
  });
});

describe("applyAndCommit — V2 conflict model", () => {
  it("worker B fails cleanly when worker A's commit changed the search anchor", async () => {
    // V2 conflict-detection scenario: two workers were assigned todos
    // touching the same file. Worker A committed first, changing the
    // text worker B was going to replace. Worker B's applyHunks fails
    // ("search not found") — it's marked failed, BlackboardRunner can
    // retry by re-prompting against the updated file content.
    const { fs } = makeFakeFs({ "shared.ts": "// CHANGED BY WORKER A" });
    const { git } = makeFakeGit();
    const workerBHunks: Hunk[] = [
      { op: "replace", file: "shared.ts", search: "// original anchor", replace: "// new" },
    ];
    const out = await applyAndCommit({
      todoId: "t-B",
      workerId: "worker-3",
      expectedFiles: ["shared.ts"],
      hunks: workerBHunks,
      fs,
      git,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.reason, /search/i);
    // The "// CHANGED BY WORKER A" stays — worker B's failure didn't roll back.
  });
});

// #296: pre-commit verification gate. Verify hook runs after writes
// land and before git commit. On failure: revert the writes + return
// failure with verifyFailed flag set so the replanner can
// distinguish "broken patch" from "stale anchor".
describe("applyAndCommit — verification gate (#296)", () => {
  it("commits normally when verify returns ok", async () => {
    const { fs, state: fsState } = makeFakeFs({ "a.ts": "hello world" });
    const { git, state: gitState } = makeFakeGit();
    let verifyCalled = 0;
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-1",
      expectedFiles: ["a.ts"],
      hunks: [{ op: "replace", file: "a.ts", search: "world", replace: "kevin" }],
      fs,
      git,
      verify: {
        async run() {
          verifyCalled++;
          return { ok: true };
        },
      },
    });
    assert.equal(verifyCalled, 1);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(fsState.files.get("a.ts"), "hello kevin");
    assert.equal(gitState.commits.length, 1);
  });

  it("reverts writes + skips commit when verify fails", async () => {
    const { fs, state: fsState } = makeFakeFs({ "a.ts": "hello world" });
    const { git, state: gitState } = makeFakeGit();
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-1",
      expectedFiles: ["a.ts"],
      hunks: [{ op: "replace", file: "a.ts", search: "world", replace: "broken" }],
      fs,
      git,
      verify: {
        async run() {
          return { ok: false, reason: "npm test failed: 3 tests failing" };
        },
      },
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.verifyFailed, true);
    assert.match(out.reason, /verify failed/i);
    assert.match(out.reason, /3 tests failing/);
    // File reverted to pre-hunk state
    assert.equal(fsState.files.get("a.ts"), "hello world");
    // No commit was made
    assert.equal(gitState.commits.length, 0);
  });

  it("truncates very long verify output to 800 chars", async () => {
    const { fs } = makeFakeFs({ "a.ts": "x" });
    const { git } = makeFakeGit();
    const huge = "stack trace: " + "x".repeat(5000);
    const out = await applyAndCommit({
      todoId: "t1", workerId: "w", expectedFiles: ["a.ts"],
      hunks: [{ op: "replace", file: "a.ts", search: "x", replace: "y" }],
      fs, git,
      verify: { async run() { return { ok: false, reason: huge }; } },
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    // "verify failed: " prefix (15 chars) + 800-char truncation
    assert.ok(out.reason.length <= 15 + 800 + 5);
  });

  it("doesn't run verify when there are no writes (empty diff)", async () => {
    const { fs } = makeFakeFs({ "a.ts": "hello" });
    const { git } = makeFakeGit();
    let verifyCalled = 0;
    // No-op replace: search === replace → no actual write
    const out = await applyAndCommit({
      todoId: "t1", workerId: "w", expectedFiles: ["a.ts"],
      hunks: [{ op: "replace", file: "a.ts", search: "hello", replace: "hello" }],
      fs, git,
      verify: { async run() { verifyCalled++; return { ok: true }; } },
    });
    assert.equal(verifyCalled, 0, "verify should not run on empty diff");
    assert.equal(out.ok, true);
  });

  it("leaves newly-created files in place on revert (no fs.delete adapter)", async () => {
    const { fs, state: fsState } = makeFakeFs({});
    const { git } = makeFakeGit();
    const out = await applyAndCommit({
      todoId: "t1", workerId: "w", expectedFiles: ["new.ts"],
      hunks: [{ op: "create", file: "new.ts", content: "freshly created" }],
      fs, git,
      verify: { async run() { return { ok: false, reason: "lint error" }; } },
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.verifyFailed, true);
    // The newly-created file remains; we don't have a delete adapter.
    // The next worker turn will see it and either modify or skip.
    assert.equal(fsState.files.get("new.ts"), "freshly created");
  });

  it("when no verify adapter supplied, behaves identically to pre-#296", async () => {
    const { fs, state: fsState } = makeFakeFs({ "a.ts": "hello world" });
    const { git, state: gitState } = makeFakeGit();
    const out = await applyAndCommit({
      todoId: "t1", workerId: "w", expectedFiles: ["a.ts"],
      hunks: [{ op: "replace", file: "a.ts", search: "world", replace: "kevin" }],
      fs, git,
      // verify omitted
    });
    assert.equal(out.ok, true);
    assert.equal(fsState.files.get("a.ts"), "hello kevin");
    assert.equal(gitState.commits.length, 1);
  });
});
