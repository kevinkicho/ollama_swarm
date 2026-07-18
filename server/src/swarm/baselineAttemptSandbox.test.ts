import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { simpleGit } from "simple-git";
import {
  prepareBaselineAttemptSandbox,
  promoteSandboxFilesToClone,
  cleanupAllBaselineAttemptSandboxes,
  baselineAttemptsRoot,
} from "./baselineAttemptSandbox.js";

describe("baselineAttemptSandbox", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-baseline-sb-"));
    // Minimal git repo
    const git = simpleGit(tmp);
    await git.init(["-q", "-b", "main"]);
    await fs.writeFile(path.join(tmp, "hello.txt"), "v1\n", "utf8");
    await fs.writeFile(path.join(tmp, "keep.md"), "stay\n", "utf8");
    await git.add(["-A"]);
    await git.raw([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test",
      "commit",
      "-m",
      "init",
    ]);
  });

  after(async () => {
    try {
      await cleanupAllBaselineAttemptSandboxes(tmp);
    } catch {
      /* */
    }
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("prepareBaselineAttemptSandbox creates isolated tree (worktree or copy)", async () => {
    const sb = await prepareBaselineAttemptSandbox(tmp, 1);
    assert.ok(
      sb.mode === "worktree" || sb.mode === "copy",
      `mode=${sb.mode}`,
    );
    assert.ok(sb.sandboxPath.includes(baselineAttemptsRoot(tmp)));
    const hello = (await fs.readFile(path.join(sb.sandboxPath, "hello.txt"), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    assert.equal(hello, "v1\n");
    // Mutate sandbox only
    await fs.writeFile(path.join(sb.sandboxPath, "hello.txt"), "v2-sandbox\n", "utf8");
    const main = (await fs.readFile(path.join(tmp, "hello.txt"), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(main, "v1\n", "main clone must stay clean");
    await sb.cleanup();
  });

  it("promoteSandboxFilesToClone copies winner files into main clone", async () => {
    const sb = await prepareBaselineAttemptSandbox(tmp, 2);
    await fs.writeFile(path.join(sb.sandboxPath, "hello.txt"), "promoted\n", "utf8");
    await fs.writeFile(path.join(sb.sandboxPath, "new-from-sb.txt"), "created\n", "utf8");
    const promo = await promoteSandboxFilesToClone({
      sandboxPath: sb.sandboxPath,
      clonePath: tmp,
      files: ["hello.txt", "new-from-sb.txt"],
    });
    assert.ok(promo.written.includes("hello.txt"));
    assert.ok(promo.written.includes("new-from-sb.txt"));
    assert.equal(
      (await fs.readFile(path.join(tmp, "hello.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "promoted\n",
    );
    assert.equal(
      (await fs.readFile(path.join(tmp, "new-from-sb.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "created\n",
    );
    await sb.cleanup();
  });

  it("cleanupAllBaselineAttemptSandboxes removes attempts root", async () => {
    const sb = await prepareBaselineAttemptSandbox(tmp, 3);
    assert.ok(
      await fs
        .stat(sb.sandboxPath)
        .then(() => true)
        .catch(() => false),
    );
    await cleanupAllBaselineAttemptSandboxes(tmp);
    const root = baselineAttemptsRoot(tmp);
    const exists = await fs
      .stat(root)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  });
});
