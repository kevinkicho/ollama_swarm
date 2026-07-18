/**
 * Git-native working-tree collaboration.
 *
 * Workers use write/edit tools to mutate the clone, then signal
 * {workingTree:true, files:[...], message:"..."}. The orchestrator must
 * **commit git reality** — not re-apply full-file write hunks (which no-op
 * when disk already matches and fail closed with "no file changes").
 *
 * Shared by blackboard propose→auditor and council direct-commit paths.
 */

import { withCloneApplyLock } from "../cloneApplyMutex.js";
import {
  noteApplyAttempt,
  noteApplySuccess,
} from "../applyIntegrityStats.js";
import { noteProductiveProgress } from "../progressHeartbeat.js";
import type { FilesystemAdapter, GitAdapter, WorkerOutcomeV2 } from "./WorkerPipeline.js";

/** Sentinel op stored in proposedHunks for git-native proposals. */
export const WORKING_TREE_MARKER_OP = "working_tree" as const;

export type WorkingTreeProposalHunk = {
  op: typeof WORKING_TREE_MARKER_OP;
  file: string;
  files: string[];
  message: string;
};

export function makeWorkingTreeProposal(
  files: readonly string[],
  message: string,
): { hunks: WorkingTreeProposalHunk[]; files: string[] } {
  const cleaned = [...new Set(files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean))];
  const msg = (message || "worker working-tree changes").slice(0, 500);
  const primary = cleaned[0] ?? ".";
  return {
    hunks: [
      {
        op: WORKING_TREE_MARKER_OP,
        file: primary,
        files: cleaned.length > 0 ? cleaned : [primary],
        message: msg,
      },
    ],
    files: cleaned.length > 0 ? cleaned : [primary],
  };
}

export function isWorkingTreeProposal(hunks: readonly unknown[]): boolean {
  if (!Array.isArray(hunks) || hunks.length === 0) return false;
  const first = hunks[0];
  if (!first || typeof first !== "object") return false;
  const op = (first as { op?: unknown }).op;
  return op === WORKING_TREE_MARKER_OP || op === "workingTree" || op === "git_commit";
}

export function workingTreeMessageFromHunks(
  hunks: readonly unknown[],
  fallback: string,
): string {
  const first = hunks[0];
  if (first && typeof first === "object") {
    const m = (first as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 500);
  }
  return fallback.slice(0, 500);
}

export function workingTreeFilesFromHunks(
  hunks: readonly unknown[],
  fallbackFiles: readonly string[],
): string[] {
  const first = hunks[0];
  if (first && typeof first === "object") {
    const f = (first as { files?: unknown }).files;
    if (Array.isArray(f) && f.length > 0) {
      return f.map(String).map((p) => p.replace(/\\/g, "/").trim()).filter(Boolean);
    }
  }
  return fallbackFiles.map(String).filter(Boolean);
}

export interface CommitWorkingTreeInput {
  todoId: string;
  workerId: string;
  files: readonly string[];
  message: string;
  fs: FilesystemAdapter;
  git: GitAdapter;
  clonePath?: string;
  runId?: string;
  /** When true, skip git commit (batch auditor path does one commit later). */
  skipCommit?: boolean;
  gitCommitOptional?: boolean;
}

/**
 * Commit files already present on disk (post write/edit tools).
 * Does not re-apply hunks — disk is the source of truth.
 */
export async function commitWorkingTreeFiles(
  input: CommitWorkingTreeInput,
): Promise<WorkerOutcomeV2> {
  return withCloneApplyLock(input.clonePath, () => commitWorkingTreeUnlocked(input));
}

async function commitWorkingTreeUnlocked(
  input: CommitWorkingTreeInput,
): Promise<WorkerOutcomeV2> {
  noteApplyAttempt(input.runId);

  const filesWritten: string[] = [];
  for (const file of input.files) {
    try {
      const text = await input.fs.read(file);
      if (text == null) {
        // Missing listed file — skip (may have been deleted intentionally)
        continue;
      }
      filesWritten.push(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `working-tree read failed for ${file}: ${msg}` };
    }
  }

  if (filesWritten.length === 0) {
    return {
      ok: false,
      reason:
        "working-tree commit: none of the listed files exist on disk — " +
        "use write/edit tools first, then {workingTree:true,files:[...]}",
    };
  }

  // skipCommit: files already on disk from write/edit; batch commit later.
  if (input.skipCommit) {
    noteApplySuccess(input.runId);
    noteProductiveProgress(input.runId);
    return {
      ok: true,
      commitSha: "working-tree-pending-batch",
      filesWritten,
      linesAdded: 0,
      linesRemoved: 0,
    };
  }

  const commitRes = await input.git.commitAll(
    input.message.slice(0, 500),
    input.workerId.slice(0, 64) || "worker",
  );
  if (!commitRes.ok) {
    if (input.gitCommitOptional) {
      noteApplySuccess(input.runId);
      noteProductiveProgress(input.runId);
      return {
        ok: true,
        commitSha: "no-git",
        filesWritten,
        linesAdded: 0,
        linesRemoved: 0,
      };
    }
    // Live 4de10651: 33× "nothing to commit" after {workingTree:true}.
    // Common causes: peer already committed the same files, or model claimed
    // workingTree without write/edit. Files exist on disk → treat as idempotent
    // success (already-settled) rather than burning more repair retries.
    const nothingToCommit = /no new SHA|nothing to commit/i.test(commitRes.reason);
    if (nothingToCommit && filesWritten.length > 0) {
      noteApplySuccess(input.runId);
      noteProductiveProgress(input.runId);
      return {
        ok: true,
        commitSha: "already-clean",
        filesWritten,
        linesAdded: 0,
        linesRemoved: 0,
      };
    }
    return {
      ok: false,
      reason:
        `working-tree git commit failed: ${commitRes.reason} — ` +
        `ensure write/edit left a dirty tree vs HEAD`,
    };
  }

  noteApplySuccess(input.runId);
  noteProductiveProgress(input.runId);
  return {
    ok: true,
    commitSha: commitRes.sha,
    filesWritten,
    linesAdded: 0,
    linesRemoved: 0,
  };
}
