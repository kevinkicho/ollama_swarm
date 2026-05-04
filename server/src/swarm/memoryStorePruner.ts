// R14 (2026-05-04): bounded swarm-memory growth.
//
// memoryStore (blackboard) accumulates one entry per finished run with
// no upper bound. After 6 months of nightly runs you'd have hundreds
// of entries; the failurePatternSeed loader reads them all into RAM +
// passes them through the planner, which makes prompts longer for
// progressively diminishing benefit (older runs predict less about
// current performance).
//
// Two pruning strategies, both pure:
//   - by age: drop entries older than `maxAgeMs`
//   - by count: keep at most `maxEntries` (most-recent first)
//
// Default policy: 90 days OR 200 entries, whichever fires first.
// Caller wires this into a periodic cleanup or runs it eagerly on
// every read.

import type { MemoryEntry } from "./blackboard/memoryStore.js";

export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60_000; // 90 days
export const DEFAULT_MAX_ENTRIES = 200;

export interface PruneInput {
  entries: readonly MemoryEntry[];
  /** Wall-clock now (ms). */
  now: number;
  /** Drop entries older than this many ms. Default 90 days. */
  maxAgeMs?: number;
  /** Cap remaining entries to this count (most-recent first). */
  maxEntries?: number;
}

export interface PruneResult {
  kept: MemoryEntry[];
  /** Entries that were filtered out (returned for diagnostics). */
  pruned: MemoryEntry[];
  /** Counts of WHY each pruned entry was dropped. */
  prunedByAge: number;
  prunedByCount: number;
}

/** Pure pruner. Returns the kept-and-pruned partition; caller
 *  rewrites storage with `kept`. Order: kept entries are sorted
 *  by ts descending (most-recent first). */
export function pruneMemoryEntries(input: PruneInput): PruneResult {
  const {
    entries,
    now,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = input;
  const sorted = [...entries].sort((a, b) => b.ts - a.ts);
  const cutoff = Number.isFinite(maxAgeMs) ? now - maxAgeMs : -Infinity;
  let prunedByAge = 0;
  const ageFiltered: MemoryEntry[] = [];
  const ageDropped: MemoryEntry[] = [];
  for (const e of sorted) {
    if (e.ts >= cutoff) {
      ageFiltered.push(e);
    } else {
      ageDropped.push(e);
      prunedByAge += 1;
    }
  }
  let kept = ageFiltered;
  let countDropped: MemoryEntry[] = [];
  let prunedByCount = 0;
  if (Number.isFinite(maxEntries) && maxEntries >= 0 && kept.length > maxEntries) {
    countDropped = kept.slice(maxEntries);
    kept = kept.slice(0, maxEntries);
    prunedByCount = countDropped.length;
  }
  return {
    kept,
    pruned: [...ageDropped, ...countDropped],
    prunedByAge,
    prunedByCount,
  };
}
