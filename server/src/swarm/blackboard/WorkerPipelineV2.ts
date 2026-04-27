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
  /** Write file text atomically. Throws on filesystem failure. */
  write: (path: string, content: string) => Promise<void>;
}

export interface GitAdapter {
  /** Stage + commit the staged changes. Returns the resulting commit
   *  SHA, or an error message when nothing to commit / git rejected. */
  commitAll: (
    message: string,
    author: string,
  ) => Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
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
    };

export interface WorkerPipelineInput {
  todoId: string;
  workerId: string;
  expectedFiles: readonly string[];
  hunks: readonly Hunk[];
  fs: FilesystemAdapter;
  git: GitAdapter;
}

/** V2 post-LLM pipeline: read files → apply hunks → write changed
 *  files → git commit. Returns a structured outcome the caller can
 *  feed back to TodoQueueV2 (complete on ok, fail on !ok). */
export async function applyAndCommitV2(input: WorkerPipelineInput): Promise<WorkerOutcomeV2> {
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
  // applyHunks expects a mutable Hunk[] but our input is readonly for
  // caller safety. Slice a defensive copy — applyHunks doesn't mutate
  // the array, but the type signature insists.
  const applied = applyHunks(contents, input.hunks.slice());
  if (!applied.ok) {
    // Try to extract the hunk index from the error message for the
    // failedHunkIndex field. applyHunks errors look like "hunk 2:
    // search not found in foo.ts" — best-effort regex.
    const match = applied.error.match(/hunk (\d+)/i);
    const idx = match ? Number.parseInt(match[1], 10) : undefined;
    return {
      ok: false,
      reason: applied.error,
      ...(idx !== undefined && Number.isFinite(idx) ? { failedHunkIndex: idx } : {}),
    };
  }

  // 3. Write only files whose content actually changed. Skipping
  //    no-op writes saves I/O AND keeps the commit's tree clean —
  //    git status would otherwise show every "touched" file even if
  //    its content matched what was on disk.
  const filesWritten: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const [file, newText] of Object.entries(applied.newTextsByFile)) {
    const before = contents[file];
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

  // 4. Empty diff: hunks applied but produced no actual changes
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

  // 5. Commit the changes. Failures here are rare (typically only
  //    "no changes" which we handled above, or git unavailable) but
  //    we return them as failures so the caller can decide policy.
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
