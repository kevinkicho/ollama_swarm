// R14 (2026-05-04): tests for bounded swarm-memory growth.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pruneMemoryEntries,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ENTRIES,
} from "./memoryStorePruner.js";
import type { MemoryEntry } from "./blackboard/memoryStore.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    ts: NOW,
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    tier: 0,
    commits: 0,
    lessons: ["test lesson"],
    ...overrides,
  };
}

test("pruneMemoryEntries — empty input → empty result", () => {
  const got = pruneMemoryEntries({ entries: [], now: NOW });
  assert.equal(got.kept.length, 0);
  assert.equal(got.pruned.length, 0);
});

test("pruneMemoryEntries — all fresh, under count cap → all kept", () => {
  const entries = [entry({ ts: NOW - 1000 }), entry({ ts: NOW - 2000 })];
  const got = pruneMemoryEntries({ entries, now: NOW });
  assert.equal(got.kept.length, 2);
  assert.equal(got.pruned.length, 0);
});

test("pruneMemoryEntries — entries older than 90 days dropped", () => {
  const entries = [
    entry({ ts: NOW - 10 * DAY, runId: "fresh" }),
    entry({ ts: NOW - 100 * DAY, runId: "ancient" }),
  ];
  const got = pruneMemoryEntries({ entries, now: NOW });
  assert.equal(got.kept.length, 1);
  assert.equal(got.kept[0].runId, "fresh");
  assert.equal(got.prunedByAge, 1);
});

test("pruneMemoryEntries — custom maxAgeMs respected", () => {
  const entries = [
    entry({ ts: NOW - 5 * DAY, runId: "ok" }),
    entry({ ts: NOW - 30 * DAY, runId: "old" }),
  ];
  const got = pruneMemoryEntries({
    entries,
    now: NOW,
    maxAgeMs: 7 * DAY,
  });
  assert.equal(got.kept.length, 1);
  assert.equal(got.kept[0].runId, "ok");
});

test("pruneMemoryEntries — count cap drops oldest first (entries beyond N)", () => {
  // 5 entries with ascending ts; cap at 3 → keep 3 newest
  const entries = Array.from({ length: 5 }, (_, i) =>
    entry({ ts: NOW - i * 1000, runId: `r-${i}` }),
  );
  const got = pruneMemoryEntries({
    entries,
    now: NOW,
    maxEntries: 3,
  });
  assert.equal(got.kept.length, 3);
  assert.equal(got.prunedByCount, 2);
  // Ts descending: r-0, r-1, r-2 should be kept
  assert.deepEqual(
    got.kept.map((e) => e.runId),
    ["r-0", "r-1", "r-2"],
  );
});

test("pruneMemoryEntries — both age and count thresholds applied", () => {
  // 200 entries; some ancient, some fresh; cap at 50
  const fresh = Array.from({ length: 100 }, (_, i) =>
    entry({ ts: NOW - i * 1000, runId: `fresh-${i}` }),
  );
  const ancient = Array.from({ length: 100 }, (_, i) =>
    entry({ ts: NOW - 100 * DAY - i * 1000, runId: `old-${i}` }),
  );
  const got = pruneMemoryEntries({
    entries: [...fresh, ...ancient],
    now: NOW,
    maxEntries: 50,
  });
  // 100 ancient drop by age, 100 fresh remain → 50 by count cap
  assert.equal(got.prunedByAge, 100);
  assert.equal(got.prunedByCount, 50);
  assert.equal(got.kept.length, 50);
});

test("pruneMemoryEntries — kept array sorted by ts descending", () => {
  const entries = [
    entry({ ts: NOW - 3000, runId: "c" }),
    entry({ ts: NOW - 1000, runId: "a" }),
    entry({ ts: NOW - 2000, runId: "b" }),
  ];
  const got = pruneMemoryEntries({ entries, now: NOW });
  assert.deepEqual(
    got.kept.map((e) => e.runId),
    ["a", "b", "c"],
  );
});

test("pruneMemoryEntries — defaults exposed (90 days, 200 entries)", () => {
  assert.equal(DEFAULT_MAX_AGE_MS, 90 * DAY);
  assert.equal(DEFAULT_MAX_ENTRIES, 200);
});

test("pruneMemoryEntries — pruned entries returned for diagnostics", () => {
  const entries = [
    entry({ ts: NOW - 100 * DAY, runId: "old" }),
    entry({ ts: NOW - 1000, runId: "new" }),
  ];
  const got = pruneMemoryEntries({ entries, now: NOW });
  assert.equal(got.pruned.length, 1);
  assert.equal(got.pruned[0].runId, "old");
});

test("pruneMemoryEntries — Infinity maxAgeMs disables age pruning", () => {
  const entries = [entry({ ts: NOW - 1000 * DAY, runId: "ancient" })];
  const got = pruneMemoryEntries({
    entries,
    now: NOW,
    maxAgeMs: Number.POSITIVE_INFINITY,
  });
  assert.equal(got.kept.length, 1);
  assert.equal(got.prunedByAge, 0);
});
