// V2 Step 5c.2: real fs + git adapters for the V2 worker pipeline.
// WorkerPipelineV2.applyAndCommitV2 is pure — these are the
// production wiring that lets it actually touch disk + git.
//
// Both adapters are scoped to a single clonePath. Reads/writes
// resolve relative paths against clonePath; resolveSafe enforces
// that no path escapes the clone (symlink defense). Git operations
// run in clonePath via simple-git.

import { promises as fs } from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { resolveSafe } from "./resolveSafe.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import type { FilesystemAdapter, GitAdapter } from "./WorkerPipelineV2.js";

/** Real filesystem adapter scoped to a clone. Reads return null on
 *  missing file (matches WorkerPipelineV2 semantics). Writes use
 *  writeFileAtomic so a crash mid-write doesn't leave a half-file. */
export function realFilesystemAdapter(clonePath: string): FilesystemAdapter {
  return {
    async read(relPath) {
      const abs = await resolveSafe(clonePath, relPath);
      try {
        return await fs.readFile(abs, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOENT/.test(msg)) return null;
        throw err;
      }
    },
    async write(relPath, content) {
      const abs = await resolveSafe(clonePath, relPath);
      // Ensure the parent directory exists. Worker hunks may create
      // a file in a directory that doesn't exist yet (e.g. new
      // src/sub/foo.ts when src/sub/ wasn't there).
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomic(abs, content);
    },
  };
}

/** Real git adapter scoped to a clone. commitAll: stage all changes
 *  + commit with the supplied message and author. Returns the new
 *  commit's SHA. Failures (typically "nothing to commit") surface
 *  as { ok: false, reason }. */
export function realGitAdapter(clonePath: string): GitAdapter {
  return {
    async commitAll(message, author) {
      const git = simpleGit(clonePath);
      try {
        await git.add(".");
        // simple-git's commit() returns CommitResult with .commit hash.
        const result = await git.commit(message, undefined, {
          // Use --author so we attribute the commit to the worker
          // without overriding the global git config (which may not
          // be set in CI / fresh clones).
          "--author": `${author} <${author}@ollama-swarm>`,
        });
        if (!result.commit) {
          return { ok: false, reason: "git commit produced no SHA (nothing staged?)" };
        }
        return { ok: true, sha: result.commit };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg };
      }
    },
  };
}
