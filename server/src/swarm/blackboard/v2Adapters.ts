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
import { spawn } from "node:child_process";
import simpleGit from "simple-git";
import { resolveSafe } from "./resolveSafe.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { checkBuildCommand } from "./buildCommandAllowlist.js";
import { killByPid } from "../../services/treeKill.js";
import type { FilesystemAdapter, GitAdapter, VerifyAdapter } from "./WorkerPipeline.js";

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
      if (content === "") {
        // Delete op (legacy path via write("")) — remove the file if it exists
        try {
          await fs.unlink(abs);
        } catch (err) {
          // File may not exist — ignore
        }
        return;
      }
      // Ensure the parent directory exists. Worker hunks may create
      // a file in a directory that doesn't exist yet (e.g. new
      // src/sub/foo.ts when src/sub/ wasn't there).
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomic(abs, content);
    },
    async delete(relPath) {
      const abs = await resolveSafe(clonePath, relPath);
      try {
        await fs.unlink(abs);
      } catch (err) {
        // File may not exist — ignore (idempotent delete)
      }
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
  const allow = checkBuildCommand(command);
  if (!allow.ok) {
    return {
      async run() {
        return { ok: false, reason: allow.reason ?? "verify command not allowed" };
      },
    };
  }

  return {
    async run() {
      try {
        // Use spawn with options.detached + cross-platform tree kill (via killByPid)
        // so the entire process group is terminated on timeout.
        // This works on Windows (taskkill /T) and POSIX.
        const cp = spawn(command, [], {
          shell: true,
          cwd: clonePath,
          stdio: "pipe",
          detached: true,
        });

        let stdout = "";
        let stderr = "";
        cp.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        cp.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

        const timeout = setTimeout(() => {
          // Cross-platform process tree kill.
          // Uses taskkill /T /F on Windows, SIGTERM+SIGKILL on POSIX.
          // This replaces the previous POSIX-only `process.kill(-pid)`.
          if (cp.pid) {
            try { killByPid(cp.pid); } catch {}
            setTimeout(() => {
              if (cp.pid) try { killByPid(cp.pid); } catch {}
            }, 2000);
          }
        }, VERIFY_TIMEOUT_MS);

        const exitCode: number | null = await new Promise((resolve, reject) => {
          cp.on("close", resolve);
          cp.on("error", reject);
        });
        clearTimeout(timeout);

        if (exitCode === 0) return { ok: true };

        const tailOf = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);
        const detail = stderr.trim() || stdout.trim() || `verify command exited with code ${exitCode}`;
        return {
          ok: false,
          reason: `verify command exited non-zero: ${tailOf(detail, 700)}`,
        };
      } catch (err) {
        // The spawn process rejects with an error that carries stdout + stderr
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
        // #304 (2026-04-28): RCA on tour v2 blackboard 0-commits.
        // git commit ALWAYS needs a committer identity (user.name +
        // user.email), even when `--author` is supplied. Fresh
        // clones have no local config + Kevin's global may not be
        // set. Force per-commit identity inline via `-c` flags so
        // we don't depend on the user's global git config OR pollute
        // the local config with persistent values.
        // The author flag remains for attribution (worker-2 vs
        // worker-3) — committer is the swarm itself.
        // Track HEAD before/after to distinguish "real commit landed"
        // from "nothing to commit" (which raw() doesn't reliably
        // throw on across simple-git versions).
        let headBefore: string | null;
        try {
          headBefore = (await git.revparse(["HEAD"])).trim();
        } catch (err) {
          console.warn('[v2Adapters] git-revparse-HEAD-failed:', err instanceof Error ? err.message : String(err));
          // No HEAD yet (empty repo) — that's fine; the commit will be the first.
          headBefore = null;
        }
        const result = await git.raw(
          "-c", "user.name=ollama-swarm",
          "-c", "user.email=swarm@ollama-swarm.local",
          "commit",
          "-m", message,
          `--author=${author} <${author}@ollama-swarm>`,
        );
        const headAfter = (await git.revparse(["HEAD"])).trim();
        if (headBefore !== null && headAfter === headBefore) {
          return {
            ok: false,
            reason: `git commit produced no new SHA — likely "nothing to commit" (output: ${result.slice(0, 200)})`,
          };
        }
        if (!headAfter || headAfter.length < 7) {
          return { ok: false, reason: `git commit returned an invalid SHA (output: ${result.slice(0, 200)})` };
        }
        return { ok: true, sha: headAfter };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg };
      }
    },
  };
}
