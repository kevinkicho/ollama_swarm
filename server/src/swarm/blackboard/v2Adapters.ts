// V2 Step 5c.2: real fs + git adapters for the V2 worker pipeline.
// WorkerPipeline.applyAndCommit is pure — these are the
// production wiring that lets it actually touch disk + git.
//
// Both adapters are scoped to a single clonePath. Reads/writes
// resolve relative paths against clonePath; resolveSafe enforces
// that no path escapes the clone (symlink defense). Git operations
// run in clonePath via simple-git.

import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import simpleGit from "simple-git";
import { resolveSafe } from "./resolveSafe.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import type { FilesystemAdapter, GitAdapter, VerifyAdapter } from "./WorkerPipeline.js";

const execAsync = promisify(exec);

/** Real filesystem adapter scoped to a clone. Reads return null on
 *  missing file (matches WorkerPipeline semantics). Writes use
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

/** #296: real verify adapter scoped to a clone. Spawns the
 *  user-supplied command via shell in the clone directory; success =
 *  exit code 0. Killed at VERIFY_TIMEOUT_MS (60s default) so a hung
 *  command doesn't stall the worker pipeline indefinitely. The
 *  combined stdout+stderr (truncated) becomes the failure reason so
 *  the user sees what the verifier actually reported. */
const VERIFY_TIMEOUT_MS = 60_000;
export function realVerifyAdapter(
  clonePath: string,
  command: string,
): VerifyAdapter {
  return {
    async run() {
      try {
        await execAsync(command, {
          cwd: clonePath,
          timeout: VERIFY_TIMEOUT_MS,
          maxBuffer: 1024 * 1024, // 1 MB of output captured
          // shell:true is implicit for exec() — accepts pipes, &&,
          // env-var expansion. Caller is the user; injection isn't
          // a threat surface (it's their own machine).
        });
        return { ok: true };
      } catch (err) {
        // execAsync rejects with an error that carries stdout + stderr
        // properties when the command exits non-zero or times out.
        const e = err as { stdout?: string; stderr?: string; signal?: string; killed?: boolean; message?: string };
        const stdout = (e.stdout ?? "").toString();
        const stderr = (e.stderr ?? "").toString();
        const tailOf = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);
        // Prefer stderr (where test failures usually print); fall back
        // to stdout, then the raw error message.
        const detail = stderr.trim() || stdout.trim() || (e.message ?? "verify exec failed");
        const reasonHead = e.killed
          ? `verify killed after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s timeout`
          : `verify command exited non-zero`;
        return {
          ok: false,
          reason: `${reasonHead}: ${tailOf(detail, 700)}`,
        };
      }
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
