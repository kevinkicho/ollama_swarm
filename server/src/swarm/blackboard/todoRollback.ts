// 2026-05-02 (blackboard feature #4): per-todo rollback on verify-fail
// or FALSE auditor verdict.
//
// Pre-fix: when verify gate fails or auditor returns FALSE for a
// criterion, the worker's commit stays in the tree. The todo gets
// marked failed; replan fires; but the broken commit lives on. Users
// who later cherry-pick the swarm's work have to manually unwind the
// known-bad commits.
//
// Fix: after a rollback-worthy failure, run `git reset --hard <parent>`
// for just-this-todo's commits. Bounded blast radius — only commits
// made by THIS todo (tracked via the commitSha returned by applyAndCommit)
// get reset. Other todos' commits remain.
//
// Pure logic + a small git helper. Best-effort: rollback failure is
// logged but doesn't throw out of the worker pipeline.

import { spawn } from "node:child_process";

export interface RollbackInput {
  /** Repo root to reset within. */
  clonePath: string;
  /** Commit SHAs to revert. The reset target is the FIRST sha's parent
   *  (i.e. one before the oldest commit in this todo's chain). */
  commitShas: readonly string[];
  /** Why we're rolling back (logged + exposed to caller for messaging). */
  reason: string;
}

export interface RollbackResult {
  ok: boolean;
  /** SHA we reset to. Absent on failure. */
  resetTo?: string;
  /** Free-text error when ok===false. */
  error?: string;
}

/** Run `git reset --hard <target>` for a per-todo rollback. Returns
 *  ok:false on any git failure; never throws. */
export async function rollbackTodoCommits(input: RollbackInput): Promise<RollbackResult> {
  if (input.commitShas.length === 0) {
    return { ok: true, resetTo: undefined };
  }
  const oldest = input.commitShas[0];
  // Resolve the parent of the oldest commit. If oldest has no parent
  // (root commit case), that's an error case — we'd be wiping history.
  const parent = await runGit(input.clonePath, ["rev-parse", `${oldest}^`]);
  if (!parent.ok) {
    return {
      ok: false,
      error: `Could not resolve parent of ${oldest}: ${parent.stderr}`,
    };
  }
  const target = parent.stdout.trim();
  if (!target) {
    return { ok: false, error: `Empty parent SHA for ${oldest}` };
  }
  const reset = await runGit(input.clonePath, ["reset", "--hard", target]);
  if (!reset.ok) {
    return { ok: false, error: `git reset failed: ${reset.stderr}` };
  }
  return { ok: true, resetTo: target };
}

/** Decide whether a failure warrants rollback. Pure — exported for
 *  tests. Rules:
 *    - applyHunks anchor failure → NO rollback (commit never landed)
 *    - verify-gate failure → YES rollback (commits landed; tests broken)
 *    - auditor FALSE on a criterion → YES rollback (work didn't meet spec)
 *    - auditor PARTIAL/UNVERIFIABLE → NO rollback (some signal of progress) */
export function shouldRollback(failure: {
  source: "verify" | "auditor" | "apply";
  verdict?: "verified" | "partial" | "false" | "unverifiable" | "unmet";
}): boolean {
  if (failure.source === "apply") return false;
  if (failure.source === "verify") return true;
  if (failure.source === "auditor") {
    return failure.verdict === "false" || failure.verdict === "unmet";
  }
  return false;
}

// ---------------------------------------------------------------------
// Internal git runner — wraps spawn + collects stdout/stderr/exit.
// ---------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: stderr + String(err), exitCode: -1 });
    });
    proc.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : -1;
      resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
    });
  });
}
