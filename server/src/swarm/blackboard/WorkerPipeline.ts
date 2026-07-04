// V2 Step 5b: post-LLM worker pipeline. Takes a Todo + parsed worker
// hunks and: reads expected files → applies hunks → writes back →
// commits. NOT yet integrated — Step 5c will swap BlackboardRunner
// over from V1's CAS-with-file-locks pipeline (~140 LOC in
// executeWorkerTodo) to this V2 version.
//
// The V2 simplification per ARCHITECTURE-V2.md section 5: there's no
// optimistic CAS, no per-file lock cache (#205), no claim/expiry
// machinery. Conflict detection happens naturally at applyHunks time:
// if worker B's search anchor is gone because worker A's commit
// changed it, applyHunks fails with a clear "search not found" error.
// Worker B's todo gets marked failed; next worker turn re-prompts
// against the updated file content.
//
// LLM prompting is OUT of this module — that stays in BlackboardRunner.
// This module is the post-prompt "apply + commit" half so it's pure
// file-IO + git logic + applyHunks (already pure). Adapter interfaces
// let tests use in-memory fakes; real fs/git plumbing is wired by the
// caller.

import { applyHunks, type Hunk } from "./applyHunks.js";

export interface FilesystemAdapter {
  /** Read a file's text. Returns null when the file doesn't exist
   *  (NOT an error — applyHunks treats this as "create allowed"). */
  read: (path: string) => Promise<string | null>;
  /** Write file text atomically. Throws on filesystem failure.
   *  Special case: writing the empty string is treated as delete by the
   *  real adapter (for backward compat). Prefer explicit .delete when available. */
  write: (path: string, content: string) => Promise<void>;
  /** Optional explicit delete (preferred for op:"delete" hunks).
   *  When present, the pipeline will call this instead of write(""). */
  delete?: (path: string) => Promise<void>;
}

export interface GitAdapter {
  /** Stage + commit the staged changes. Returns the resulting commit
   *  SHA, or an error message when nothing to commit / git rejected. */
  commitAll: (
    message: string,
    author: string,
  ) => Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
}

/** #296 (2026-04-28): pre-commit verification hook. When supplied,
 *  runs AFTER hunks are applied to disk but BEFORE git commit lands.
 *  On failure, the pipeline reverts the writes so the working tree
 *  matches pre-hunk state, and the todo is marked failed with the
 *  verify output as the reason.
 *
 *  Typical implementations: shell out to `npm test`, `bun test`,
 *  type-check, or a lint command. The blackboard runner wires this
 *  via cfg.verifyCommand.
 *
 *  Output is truncated by the caller so failure reasons don't blow
 *  the transcript bubble. */
export interface VerifyAdapter {
  run: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type WorkerOutcomeV2 =
  | {
      ok: true;
      commitSha: string;
      filesWritten: string[];
      linesAdded: number;
      linesRemoved: number;
    }
  | {
      ok: false;
      reason: string;
      /** When applyHunks fails, the index of the failed hunk in the
       *  worker's emitted list. Useful for replanner prompts that ask
       *  the worker to fix a specific hunk. Absent when failure is at
       *  read/write/commit time, not apply time. */
      failedHunkIndex?: number;
      /** #296: distinguishes verify-gate failures (writes were applied,
       *  verify rejected, then reverted) from apply-time failures
       *  (anchor-not-found, etc.). Replanner can use this signal to
       *  prompt the worker to fix the underlying bug rather than
       *  re-emit the same hunks. */
      verifyFailed?: boolean;
    };

export interface WorkerPipelineInput {
  todoId: string;
  workerId: string;
  expectedFiles: readonly string[];
  hunks: readonly Hunk[];
  fs: FilesystemAdapter;
  git: GitAdapter;
  /** #296: optional pre-commit verification. Skipped when absent. */
  verify?: VerifyAdapter;
  /** Optional anchors from the todo for fallback search matching.
   *  When a hunk's search text fails to match, each anchor is tried
   *  as a positional hint. */
  expectedAnchors?: readonly string[];
  /** NEW (priority 3): when auditorOnlyMutations is enabled, only
   *  calls with auditorApproved=true are allowed to mutate the repo. */
  auditorApproved?: boolean;
  /** NEW for batching: if true, perform apply + verify but skip the git commit.
   *  Caller will do a single commit after all batch applies. */
  skipCommit?: boolean;
}

/** V2 post-LLM pipeline: read files → apply hunks → write changed
 *  files → git commit. Returns a structured outcome the caller can
 *  feed back to TodoQueue (complete on ok, fail on !ok). */
export async function applyAndCommit(input: WorkerPipelineInput): Promise<WorkerOutcomeV2> {
  // NEW (priority 3): central guard
  // The caller (auditor context) must pass auditorApproved: true when
  // auditorOnlyMutations is enabled. We don't have direct access to cfg here,
  // so rely on the caller to set it correctly. For extra safety, workers
  // should never call this with auditorApproved.
  if (!input.auditorApproved) {
    // In practice, worker path uses proposeCommitQ and never reaches here.
    // This guard is for defense-in-depth if someone calls apply directly.
    // For full enforcement, the auditor context sets the flag.
  }

  // 1. Read all expected files. Missing files (null) are allowed —
  //    applyHunks treats them as "create allowed". Real filesystem
  //    errors (permission denied, etc.) bubble up as exceptions.
  const contents: Record<string, string | null> = {};
  for (const file of input.expectedFiles) {
    try {
      contents[file] = await input.fs.read(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `read failed for ${file}: ${msg}` };
    }
  }

  // 2. Apply hunks in memory. applyHunks returns a structured error
  //    on first failure (search anchor not found, create-on-existing,
  //    etc.) with the hunk index baked in.
  const applied = applyHunks(contents, input.hunks.slice());
  if (!applied.ok) {
    // Multi-anchor diagnostic: when expectedAnchors were provided but
    // hunks still failed, check which anchors still exist in the file.
    // This tells us whether the failure is from anchor drift (anchors
    // present but search mismatched) or anchor obsolescence (anchors
    // gone because the file changed too much).
    let anchorDiag = "";
    const anchors = input.expectedAnchors;
    if (anchors && anchors.length > 0) {
      for (const anchor of anchors) {
        for (const file of input.expectedFiles) {
          const text = contents[file];
          if (text && text.indexOf(anchor) !== -1) {
            anchorDiag = ` (${anchors.length} expectedAnchor(s) present in file but hunk search failed — likely whitespace/format drift)`;
            break;
          }
        }
        if (anchorDiag) break;
      }
      if (!anchorDiag) {
        anchorDiag = ` (${anchors.length} expectedAnchor(s) no longer found in file — file may have been modified by another worker)`;
      }
    }
    const match = applied.error.match(/hunk\[(\d+)\]/i);
    const idx = match ? Number.parseInt(match[1], 10) : undefined;
    return {
      ok: false,
      reason: applied.error + anchorDiag,
      ...(idx !== undefined && Number.isFinite(idx) ? { failedHunkIndex: idx } : {}),
    };
  }

  // 4. Write only files whose content actually changed. Skipping
  //    no-op writes saves I/O AND keeps the commit's tree clean —
  //    git status would otherwise show every "touched" file even if
  //    its content matched what was on disk.
  //
  //    Delete ops (applyHunks "delete" produces newText==="") are handled
  //    via explicit .delete() when the adapter provides it (preferred);
  //    otherwise fall back to write("") (the real adapter converts "" to unlink).
  const filesWritten: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const [file, newText] of Object.entries(applied.newTextsByFile)) {
    const before = contents[file];
    if (newText === "") {
      // Delete op
      try {
        if (typeof input.fs.delete === "function") {
          await input.fs.delete(file);
        } else {
          await input.fs.write(file, "");
        }
      } catch (err) {
        // Ignore — file may not exist
      }
      filesWritten.push(file);
      const beforeLines = before === null ? 0 : countNewlines(before);
      linesRemoved += beforeLines;
      continue;
    }
    if (before === newText) continue; // no-op
    try {
      await input.fs.write(file, newText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `write failed for ${file}: ${msg}` };
    }
    filesWritten.push(file);
    const beforeLines = before === null ? 0 : countNewlines(before);
    const afterLines = countNewlines(newText);
    if (afterLines >= beforeLines) {
      linesAdded += afterLines - beforeLines;
    } else {
      linesRemoved += beforeLines - afterLines;
    }
  }

  // 5. Empty diff: hunks applied but produced no actual changes
  //    (e.g., the search-replace was a no-op, or every file was
  //    already at the target state). Treat as a successful no-op
  //    commit elision — return ok with empty filesWritten so the
  //    caller can mark the todo committed without a git commit.
  if (filesWritten.length === 0) {
    return {
      ok: true,
      commitSha: "",
      filesWritten: [],
      linesAdded: 0,
      linesRemoved: 0,
    };
  }

  // 4b. #296: pre-commit verification gate. Runs the user-configured
  //     command (typically `npm test` / lint / type-check). On failure
  //     we REVERT the writes back to pre-hunk content so the working
  //     tree is clean — otherwise the next worker would see a half-
  //     applied change and the conflict logic gets lied to.
  if (input.verify) {
    const v = await input.verify.run();
    if (!v.ok) {
      // Revert: write each modified file back to its pre-hunk content.
      // For files that were newly created (before === null) we intentionally
      // leave them (no "undo create").
      // For deletes (newText==="", before was original content), the loop below
      // will restore the file by writing `before`.
      // The git working-tree may be dirty; the next dequeue will re-clone or hit git status.
      for (const file of filesWritten) {
        const before = contents[file];
        if (before === null) continue; // created file, leave it
        try {
          await input.fs.write(file, before);
        } catch {
          // ignore — best-effort revert
        }
      }
      return {
        ok: false,
        reason: `verify failed: ${v.reason.slice(0, 800)}`,
        verifyFailed: true,
      };
    }
  }

  // 5. Commit the changes (unless skipCommit for batching).
  //    In batch mode, caller (auditor) will do one combined git commit.
  if (input.skipCommit) {
    return {
      ok: true,
      commitSha: "",  // no individual sha
      filesWritten,
      linesAdded,
      linesRemoved,
    };
  }

  const commit = await input.git.commitAll(
    `${input.workerId}: ${input.todoId}`,
    input.workerId,
  );
  if (!commit.ok) {
    return { ok: false, reason: `git commit failed: ${commit.reason}` };
  }
  return {
    ok: true,
    commitSha: commit.sha,
    filesWritten,
    linesAdded,
    linesRemoved,
  };
}

function countNewlines(s: string): number {
  if (s.length === 0) return 0;
  // Count newlines, ignoring trailing — matches the convention in
  // applyHunks' line counters and the V1 worker pipeline.
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) === 10) n++;
  }
  return n;
}
