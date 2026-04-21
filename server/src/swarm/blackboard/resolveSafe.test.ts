import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafe } from "./resolveSafe.js";

let tmpRoot: string;
let clone: string;
let outside: string;
let cloneReal: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-rs-"));
  clone = path.join(tmpRoot, "clone");
  outside = path.join(tmpRoot, "outside");
  await fs.mkdir(clone, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.join(clone, "src"));
  await fs.mkdir(path.join(clone, ".git"));
  await fs.writeFile(path.join(clone, "src", "ok.ts"), "hello");
  await fs.writeFile(path.join(outside, "secret.txt"), "pwned");
  cloneReal = await fs.realpath(clone);
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Windows file-symlink creation requires admin/developer mode, so several
// symlink tests self-skip when fs.symlink throws EPERM. Junctions work
// without privilege on Windows for directory targets.
async function trySymlink(
  target: string,
  linkPath: string,
  type?: "dir" | "file" | "junction",
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS") return false;
    throw err;
  }
}

describe("resolveSafe — lexical checks", () => {
  it("returns the absolute path for a simple relative target", async () => {
    const abs = await resolveSafe(clone, "src/ok.ts");
    assert.equal(abs, path.join(cloneReal, "src", "ok.ts"));
  });

  it("rejects an absolute path", async () => {
    await assert.rejects(resolveSafe(clone, "/etc/passwd"), /absolute path not allowed/);
  });

  it("rejects a path that lexically escapes with ..", async () => {
    await assert.rejects(resolveSafe(clone, "../outside/secret.txt"), /escapes clone/);
  });

  it("rejects a path inside .git at the top level", async () => {
    await assert.rejects(resolveSafe(clone, ".git/config"), /inside \.git/);
  });

  it("rejects a path with .git deeper in the tree", async () => {
    await assert.rejects(
      resolveSafe(clone, "src/.git/hooks/pre-commit"),
      /inside \.git/,
    );
  });

  it("rejects when the clone path is empty", async () => {
    await assert.rejects(resolveSafe("", "src/ok.ts"), /no active clone path/);
  });

  it("accepts a target whose parent directory does not yet exist", async () => {
    const abs = await resolveSafe(clone, "src/new/subdir/file.ts");
    assert.equal(abs, path.join(cloneReal, "src", "new", "subdir", "file.ts"));
  });
});

describe("resolveSafe — symlink checks", () => {
  it("rejects writing through a directory symlink that points outside the clone", async () => {
    const link = path.join(clone, "evil-dir");
    if (!(await trySymlink(outside, link, "junction"))) return;
    try {
      await assert.rejects(
        resolveSafe(clone, "evil-dir/secret.txt"),
        /escapes clone via symlink/,
      );
    } finally {
      await fs.rm(link, { recursive: true, force: true });
    }
  });

  it("accepts a directory symlink that points to another directory inside the clone", async () => {
    const link = path.join(clone, "inner-link");
    const target = path.join(clone, "src");
    if (!(await trySymlink(target, link, "junction"))) return;
    try {
      const abs = await resolveSafe(clone, "inner-link/ok.ts");
      assert.equal(abs, path.join(cloneReal, "src", "ok.ts"));
    } finally {
      await fs.rm(link, { recursive: true, force: true });
    }
  });

  it("rejects writing through a symlink that lands inside .git", async () => {
    const link = path.join(clone, "git-alias");
    const target = path.join(clone, ".git");
    if (!(await trySymlink(target, link, "junction"))) return;
    try {
      await assert.rejects(
        resolveSafe(clone, "git-alias/config"),
        /inside \.git via symlink/,
      );
    } finally {
      await fs.rm(link, { recursive: true, force: true });
    }
  });

  it("rejects writing through a dangling symlink", async () => {
    const link = path.join(clone, "dangling");
    const missingTarget = path.join(tmpRoot, "does-not-exist");
    // We want a link whose target doesn't exist. On Windows junctions require
    // an existing target, so this test only runs on platforms where a plain
    // file-or-dir symlink works and can point at a missing path.
    if (!(await trySymlink(missingTarget, link))) return;
    try {
      await assert.rejects(
        resolveSafe(clone, "dangling/foo.ts"),
        /dangling symlink/,
      );
    } finally {
      await fs.rm(link, { recursive: true, force: true });
    }
  });
});
