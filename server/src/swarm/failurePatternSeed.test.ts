// Q2 (2026-05-04): tests for failure-pattern memory seed helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFailurePatternSeed,
  looksLikeFailure,
  looksLikeSuccess,
  FAILURE_SEED_MAX_ENTRIES,
} from "./failurePatternSeed.js";
import type { MemoryEntry } from "./blackboard/memoryStore.js";

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    ts: 1_700_000_000_000,
    runId: "run-1",
    tier: 0,
    commits: 0,
    lessons: ["did the thing"],
    ...overrides,
  };
}

test("looksLikeFailure — commits=0 + tier=0 → true", () => {
  assert.equal(looksLikeFailure(entry({ commits: 0, tier: 0 })), true);
});

test("looksLikeFailure — commits>0 → false", () => {
  assert.equal(looksLikeFailure(entry({ commits: 1, tier: 0 })), false);
});

test("looksLikeFailure — tier>0 → false", () => {
  assert.equal(looksLikeFailure(entry({ commits: 0, tier: 1 })), false);
});

test("looksLikeSuccess — commits>0 → true", () => {
  assert.equal(looksLikeSuccess(entry({ commits: 5 })), true);
});

test("looksLikeSuccess — tier>0 → true", () => {
  assert.equal(looksLikeSuccess(entry({ tier: 2 })), true);
});

test("buildFailurePatternSeed — empty input → empty text", () => {
  const got = buildFailurePatternSeed({ entries: [] });
  assert.equal(got.text, "");
  assert.equal(got.failureCount, 0);
  assert.equal(got.successCount, 0);
});

test("buildFailurePatternSeed — pure-failure entries surface in failures section", () => {
  const got = buildFailurePatternSeed({
    entries: [entry({ runId: "fail-1", commits: 0, tier: 0, lessons: ["spent budget on tests"] })],
    now: 1_700_086_400_000, // 1 day later
  });
  assert.match(got.text, /Past attempts that produced NO commits/);
  assert.match(got.text, /fail-1/);
  assert.match(got.text, /spent budget on tests/);
  assert.equal(got.failureCount, 1);
  assert.equal(got.successCount, 0);
});

test("buildFailurePatternSeed — pure-success entries surface in successes section", () => {
  const got = buildFailurePatternSeed({
    entries: [entry({ runId: "win-1", commits: 5, tier: 1, lessons: ["small atomic todos worked"] })],
    now: 1_700_086_400_000,
  });
  assert.match(got.text, /Past attempts that LANDED commits/);
  assert.match(got.text, /win-1/);
  assert.match(got.text, /small atomic todos worked/);
  assert.equal(got.successCount, 1);
});

test("buildFailurePatternSeed — caps at FAILURE_SEED_MAX_ENTRIES (most recent first)", () => {
  const tooMany = Array.from({ length: FAILURE_SEED_MAX_ENTRIES + 3 }, (_, i) =>
    entry({
      ts: 1_700_000_000_000 + i * 1000,
      runId: `r${i}`,
      commits: 0,
      tier: 0,
      lessons: [`lesson ${i}`],
    }),
  );
  const got = buildFailurePatternSeed({ entries: tooMany });
  // Highest-ts should be first; lowest dropped
  assert.equal(got.failureCount, FAILURE_SEED_MAX_ENTRIES);
  assert.match(
    got.text,
    new RegExp(`r${FAILURE_SEED_MAX_ENTRIES + 2}`),
    "newest entry surfaces first",
  );
  // The oldest entry that got dropped (r0) should NOT appear
  assert.equal(got.text.includes("lesson 0"), false);
});

test("buildFailurePatternSeed — flags very-old entries (>90d)", () => {
  const got = buildFailurePatternSeed({
    entries: [
      entry({
        ts: 1_700_000_000_000,
        runId: "ancient",
        commits: 0,
        tier: 0,
        lessons: ["x"],
      }),
    ],
    // 100 days later
    now: 1_700_000_000_000 + 100 * 24 * 60 * 60_000,
  });
  assert.match(got.text, /VERY OLD/);
});

test("buildFailurePatternSeed — mixed input renders both sections", () => {
  const got = buildFailurePatternSeed({
    entries: [
      entry({ runId: "win", commits: 3, lessons: ["good"] }),
      entry({ runId: "fail", commits: 0, tier: 0, lessons: ["bad"] }),
    ],
  });
  assert.match(got.text, /Past attempts that produced NO commits/);
  assert.match(got.text, /Past attempts that LANDED commits/);
  assert.equal(got.failureCount, 1);
  assert.equal(got.successCount, 1);
});
