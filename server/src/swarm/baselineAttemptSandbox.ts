/**
 * Isolated sandboxes for multi-attempt baseline so each attempt can use
 * write/edit tools without polluting the shared clone (or sibling attempts).
 *
 * Prefer `git worktree add --detach` (cheap, shares objects). Fall back to
 * a filtered recursive copy when worktree is unavailable.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";

const ATTEMPTS_DIR = ".swarm-baseline-attempts";

export interface BaselineAttemptSandbox {
  sandboxPath: string;
  /** How the sandbox was created (for diagnostics). */
  mode: "worktree" | "copy";
  cleanup: () => Promise<void>;
}

/** Root dir holding all attempt sandboxes for a clone. */
export function baselineAttemptsRoot(clonePath: string): string {
  return path.join(clonePath, ATTEMPTS_DIR);
}

/**
 * Create an isolated sandbox for attempt N under
 * `<clone>/.swarm-baseline-attempts/aN`.
 */
export async function prepareBaselineAttemptSandbox(
  clonePath: string,
  attempt: number,
): Promise<BaselineAttemptSandbox> {
  const root = baselineAttemptsRoot(clonePath);
  const sandboxPath = path.join(root, `a${attempt}`);
  await fs.mkdir(root, { recursive: true });
  await fs.rm(sandboxPath, { recursive: true, force: true });

  // Prefer git worktree — shared objects, isolated index/worktree.
  try {
    const git = simpleGit(clonePath);
    await git.raw(["worktree", "prune"]);
    // Detached HEAD at current tip — no new branch pollution.
    await git.raw(["worktree", "add", "--detach", sandboxPath, "HEAD"]);
    return {
      sandboxPath,
      mode: "worktree",
      cleanup: async () => {
        try {
          await git.raw(["worktree", "remove", "--force", sandboxPath]);
        } catch {
          try {
            await fs.rm(sandboxPath, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      },
    };
  } catch {
    /* fall through to copy */
  }

  await copyTreeForSandbox(clonePath, sandboxPath);
  return {
    sandboxPath,
    mode: "copy",
    cleanup: async () => {
      try {
        await fs.rm(sandboxPath, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Best-effort remove the entire attempts root (all sandboxes). */
export async function cleanupAllBaselineAttemptSandboxes(
  clonePath: string,
): Promise<void> {
  const root = baselineAttemptsRoot(clonePath);
  try {
    const git = simpleGit(clonePath);
    // List and remove worktrees under the attempts root.
    try {
      const list = await git.raw(["worktree", "list", "--porcelain"]);
      for (const block of list.split("\n\n")) {
        const m = block.match(/^worktree (.+)$/m);
        if (!m?.[1]) continue;
        const wt = m[1].trim();
        if (wt.startsWith(root) || path.resolve(wt).startsWith(path.resolve(root))) {
          try {
            await git.raw(["worktree", "remove", "--force", wt]);
          } catch {
            /* */
          }
        }
      }
    } catch {
      /* */
    }
    await git.raw(["worktree", "prune"]);
  } catch {
    /* not a git repo or worktree unavailable */
  }
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Copy selected files from a sandbox into the canonical clone path
 * (used when the winning attempt used tools + workingTree in isolation).
 */
export async function promoteSandboxFilesToClone(input: {
  sandboxPath: string;
  clonePath: string;
  files: readonly string[];
}): Promise<{ written: string[]; missing: string[] }> {
  const written: string[] = [];
  const missing: string[] = [];
  for (const rel of input.files) {
    const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!clean || clean.includes("..")) continue;
    const src = path.join(input.sandboxPath, clean);
    const dest = path.join(input.clonePath, clean);
    try {
      const st = await fs.stat(src);
      if (!st.isFile()) {
        missing.push(clean);
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      written.push(clean);
    } catch {
      missing.push(clean);
    }
  }
  return { written, missing };
}

const COPY_SKIP_NAMES = new Set([
  ATTEMPTS_DIR,
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

async function copyTreeForSandbox(srcRoot: string, destRoot: string): Promise<void> {
  await fs.mkdir(destRoot, { recursive: true });
  async function walk(rel: string): Promise<void> {
    const src = path.join(srcRoot, rel);
    const dest = path.join(destRoot, rel);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      if (COPY_SKIP_NAMES.has(ent.name)) continue;
      // Always copy .git so git_status/diff tools work in the sandbox.
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const childSrc = path.join(srcRoot, childRel);
      const childDest = path.join(destRoot, childRel);
      if (ent.isDirectory()) {
        await fs.mkdir(childDest, { recursive: true });
        await walk(childRel);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        await fs.mkdir(path.dirname(childDest), { recursive: true });
        try {
          await fs.copyFile(childSrc, childDest);
        } catch {
          /* skip locked/unreadable */
        }
      }
    }
  }
  await walk("");
}
