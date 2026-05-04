// Q2 (2026-05-04): failure-pattern memory at run start.
//
// `.swarm-memory.jsonl` already accumulates per-run lessons (see
// `blackboard/memoryStore.ts`). On a fresh run, the planner's seed
// can include a "lessons from past failed runs on THIS repo" block
// so the planner avoids repeating known dead ends.
//
// Pure helpers — no LLM call, no I/O. The runner reads the memory
// file via the existing `readMemory()` then passes entries here to
// extract a planner-seed-friendly text block.
//
// Tradeoffs:
//   - Memory drifts over time — old lessons may not apply if the
//     repo has changed. Cap at the most-recent N entries via
//     FAILURE_SEED_MAX_ENTRIES.
//   - "Failure" detection is heuristic (low commits + tier=0). False
//     positives (an intentional discussion run with 0 commits)
//     mostly bias the seed toward "be more cautious", which is the
//     safe direction.

import type { MemoryEntry } from "./blackboard/memoryStore.js";

/** Most-recent N "failure-pattern" entries to surface in the seed.
 *  Capping keeps the prompt small + biases toward recent learnings. */
export const FAILURE_SEED_MAX_ENTRIES = 5;

/** Most-recent N "success-pattern" entries to surface alongside the
 *  failures so the planner sees "what worked here" too. */
export const SUCCESS_SEED_MAX_ENTRIES = 3;

/** Heuristic: an entry "looks like a failure" when commits === 0
 *  AND tier === 0 (run never made progress). Discussion presets
 *  intentionally produce 0 commits + tier=0 too — we accept the
 *  false-positive rate; the planner-side framing handles it ("might
 *  be a discussion run"). */
export function looksLikeFailure(entry: MemoryEntry): boolean {
  return entry.commits === 0 && entry.tier === 0;
}

/** Heuristic: an entry "looks like a success" when commits > 0 OR
 *  tier > 0. Most-recent-first ordering signals "what worked
 *  recently on this repo". */
export function looksLikeSuccess(entry: MemoryEntry): boolean {
  return entry.commits > 0 || entry.tier > 0;
}

export interface FailurePatternSeed {
  /** Block ready to paste into the planner's seed prompt. Empty
   *  string when no relevant entries exist. */
  text: string;
  /** Counts surfaced for telemetry / transcript framing. */
  failureCount: number;
  successCount: number;
}

/** Build the planner-seed block. Returns empty text when there's
 *  nothing useful to surface (no past entries, or all so old that
 *  surfacing them would be misleading).
 *
 *  Pure — exported for tests; call from the runner with the result
 *  of `readMemory(clonePath)`. */
export function buildFailurePatternSeed(args: {
  entries: readonly MemoryEntry[];
  /** Wall-clock now; used to flag entries older than 90 days as
   *  "very old" inside the rendered text. */
  now?: number;
}): FailurePatternSeed {
  const now = args.now ?? Date.now();
  const sortedNewestFirst = [...args.entries].sort((a, b) => b.ts - a.ts);
  const failures = sortedNewestFirst
    .filter(looksLikeFailure)
    .slice(0, FAILURE_SEED_MAX_ENTRIES);
  const successes = sortedNewestFirst
    .filter(looksLikeSuccess)
    .slice(0, SUCCESS_SEED_MAX_ENTRIES);
  if (failures.length === 0 && successes.length === 0) {
    return { text: "", failureCount: 0, successCount: 0 };
  }
  const lines: string[] = [];
  lines.push("=== Lessons from past runs on this repo (.swarm-memory.jsonl) ===");
  lines.push("Use these to avoid repeating known dead ends + reinforce known wins.");
  lines.push("");
  if (failures.length > 0) {
    lines.push("Past attempts that produced NO commits (often discussion runs OR genuine failures):");
    for (const e of failures) {
      const ageDays = Math.round((now - e.ts) / (24 * 60 * 60_000));
      const ageNote = ageDays > 90 ? ` (${ageDays}d ago — VERY OLD)` : ` (${ageDays}d ago)`;
      lines.push(`  - run ${e.runId.slice(0, 8)}${ageNote}:`);
      for (const lesson of e.lessons) {
        lines.push(`      - ${lesson.trim()}`);
      }
    }
    lines.push("");
  }
  if (successes.length > 0) {
    lines.push("Past attempts that LANDED commits (replicate what worked):");
    for (const e of successes) {
      const ageDays = Math.round((now - e.ts) / (24 * 60 * 60_000));
      lines.push(
        `  - run ${e.runId.slice(0, 8)} (${ageDays}d ago, tier=${e.tier}, commits=${e.commits}):`,
      );
      for (const lesson of e.lessons) {
        lines.push(`      - ${lesson.trim()}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "When YOUR plan would repeat a past dead end, propose a different angle instead.",
  );
  lines.push("=== End past-run lessons ===");
  return {
    text: lines.join("\n"),
    failureCount: failures.length,
    successCount: successes.length,
  };
}
