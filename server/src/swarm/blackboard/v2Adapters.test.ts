// V2 Step 5c.2 tests: real fs + git adapters against a tmpdir git
// repo. Uses execSync for git setup (mirroring RepoService.test.ts
// pattern) so we can verify simple-git commits land cleanly.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { realFilesystemAdapter, realGitAdapter } from "./v2Adapters.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-adapters-test-"));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function freshRepo(name: string): Promise<string> {
  const repo = path.join(tmpRoot, name);
  await fs.mkdir(repo, { recursive: true });
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email test@example.com", { cwd: repo });
  execSync("git config user.name Test", { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "# init\n", "utf8");
  execSync("git add README.md && git commit -q -m initial", { cwd: repo });
  return repo;
}

describe("realFilesystemAdapter", () => {
  it("read returns content for existing file", async () => {
    const repo = await freshRepo("fs-read-existing");
    const fsAdapter = realFilesystemAdapter(repo);
    const content = await fsAdapter.read("README.md");
    assert.equal(content, "# init\n");
  });

  it("read returns null for missing file (no throw)", async () => {
    const repo = await freshRepo("fs-read-missing");
    const fsAdapter = realFilesystemAdapter(repo);
    const content = await fsAdapter.read("nonexistent.txt");
    assert.equal(content, null);
  });

  it("write creates a new file atomically", async () => {
    const repo = await freshRepo("fs-write-new");
    const fsAdapter = realFilesystemAdapter(repo);
    await fsAdapter.write("new.txt", "hello v2\n");
    const content = await fs.readFile(path.join(repo, "new.txt"), "utf8");
    assert.equal(content, "hello v2\n");
  });

  it("write creates parent directories as needed", async () => {
    const repo = await freshRepo("fs-write-mkdir");
    const fsAdapter = realFilesystemAdapter(repo);
    await fsAdapter.write("src/sub/deep/file.ts", "// deep\n");
    const content = await fs.readFile(path.join(repo, "src/sub/deep/file.ts"), "utf8");
    assert.equal(content, "// deep\n");
  });

  it("write overwrites an existing file atomically", async () => {
    const repo = await freshRepo("fs-write-overwrite");
    const fsAdapter = realFilesystemAdapter(repo);
    await fsAdapter.write("README.md", "# replaced\n");
    const content = await fs.readFile(path.join(repo, "README.md"), "utf8");
    assert.equal(content, "# replaced\n");
  });

  it("read rejects path-escape attempts (resolveSafe enforces clone scope)", async () => {
    const repo = await freshRepo("fs-escape");
    const fsAdapter = realFilesystemAdapter(repo);
    await assert.rejects(() => fsAdapter.read("../../etc/passwd"));
  });
});

describe("realGitAdapter", () => {
  it("commitAll stages + commits + returns SHA", async () => {
    const repo = await freshRepo("git-commit-basic");
    await fs.writeFile(path.join(repo, "added.txt"), "new file\n", "utf8");
    const gitAdapter = realGitAdapter(repo);
    const result = await gitAdapter.commitAll("test commit", "worker-2");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.sha, /^[a-f0-9]{7,}$/);
    // Verify the commit landed
    const log = execSync("git log --oneline -1", { cwd: repo }).toString();
    assert.match(log, /test commit/);
  });

  it("commitAll uses --author so the worker is attributed", async () => {
    const repo = await freshRepo("git-commit-author");
    await fs.writeFile(path.join(repo, "x.txt"), "x", "utf8");
    const gitAdapter = realGitAdapter(repo);
    const result = await gitAdapter.commitAll("authored", "worker-7");
    assert.equal(result.ok, true);
    const log = execSync("git log --pretty=format:%an -1", { cwd: repo }).toString();
    assert.equal(log.trim(), "worker-7");
  });

  it("commitAll fails when nothing to commit", async () => {
    const repo = await freshRepo("git-commit-empty");
    const gitAdapter = realGitAdapter(repo);
    const result = await gitAdapter.commitAll("empty", "worker-2");
    assert.equal(result.ok, false);
  });

  // #304 (2026-04-28): RCA on tour v2 blackboard 0-commits.
  // The production failure mode was clones with NO local git
  // user.name + user.email config (typical for fresh clones).
  // git commit silently fails with "Committer identity unknown"
  // even when --author is supplied. The adapter now passes
  // identity inline via `-c user.name=... -c user.email=...` so
  // it doesn't depend on global git config OR pollute the local
  // config. This test reproduces a clone with no committer
  // identity + verifies commits land cleanly.
  it("commitAll succeeds when the clone has no committer identity (#304)", async () => {
    // Fresh repo WITHOUT setting user.email/user.name.
    const repo = path.join(tmpRoot, "git-no-identity");
    await fs.mkdir(repo, { recursive: true });
    execSync("git init -q", { cwd: repo });
    // Explicitly UNSET any inherited config so we mimic the
    // production scenario where the worker's clone has no identity.
    try { execSync("git config --unset user.email", { cwd: repo }); } catch {}
    try { execSync("git config --unset user.name", { cwd: repo }); } catch {}
    await fs.writeFile(path.join(repo, "first.txt"), "init\n", "utf8");
    // Even the initial commit needs identity — bootstrap with the
    // same inline -c flags the adapter uses, so the test setup
    // doesn't depend on global config.
    execSync(
      'git -c user.name=test-init -c user.email=init@test commit -q -m initial --allow-empty',
      { cwd: repo },
    );
    execSync("git add first.txt", { cwd: repo });
    execSync(
      'git -c user.name=test-init -c user.email=init@test commit -q -m bootstrap',
      { cwd: repo },
    );

    // Now exercise the adapter — should succeed even without local
    // config thanks to the inline -c flags it injects.
    await fs.writeFile(path.join(repo, "added.txt"), "by adapter\n", "utf8");
    const gitAdapter = realGitAdapter(repo);
    const result = await gitAdapter.commitAll("worker commit", "worker-3");
    assert.equal(result.ok, true, "commit should succeed without local user.* config");
    if (!result.ok) return;
    assert.match(result.sha, /^[a-f0-9]{7,}$/);
    // Verify committer identity + author identity are both correctly set.
    const committer = execSync("git log --pretty=format:%cn -1", { cwd: repo }).toString().trim();
    const author = execSync("git log --pretty=format:%an -1", { cwd: repo }).toString().trim();
    assert.equal(committer, "ollama-swarm", `committer should be ollama-swarm, got ${committer}`);
    assert.equal(author, "worker-3", `author should be worker-3, got ${author}`);
  });
});

describe("v2Adapters — end-to-end with WorkerPipeline", () => {
  it("applyAndCommit against real adapters: hunks → file change → commit", async () => {
    const { applyAndCommit } = await import("./WorkerPipeline.js");
    const repo = await freshRepo("e2e-pipeline");
    const fsAdapter = realFilesystemAdapter(repo);
    const gitAdapter = realGitAdapter(repo);
    const out = await applyAndCommit({
      todoId: "t1",
      workerId: "worker-2",
      expectedFiles: ["README.md"],
      hunks: [
        { op: "replace", file: "README.md", search: "# init\n", replace: "# v2 wins\n" },
      ],
      fs: fsAdapter,
      git: gitAdapter,
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.match(out.commitSha, /^[a-f0-9]{7,}$/);
    assert.deepEqual(out.filesWritten, ["README.md"]);
    // Verify on disk + in git
    const onDisk = await fs.readFile(path.join(repo, "README.md"), "utf8");
    assert.equal(onDisk, "# v2 wins\n");
    const log = execSync("git log --oneline", { cwd: repo }).toString().trim().split("\n");
    assert.equal(log.length, 2); // initial + this one
  });
});
