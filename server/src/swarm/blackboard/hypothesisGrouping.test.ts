// T-Item-3 (2026-05-04): unit tests for hypothesis-tag detection +
// group assignment + conflict-detection helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHypothesisTag,
  assignHypothesisGroups,
  expectedFilesOverlap,
  evaluateConflictDispatch,
  updateDeferralTimestamps,
  CONFLICT_DEFERRAL_MAX_MS,
  type CandidateForConflict,
} from "./hypothesisGrouping.js";

test("detectHypothesisTag — extracts canonical single-letter token", () => {
  assert.equal(detectHypothesisTag("[hypothesis: A] Use bcrypt"), "A");
  assert.equal(detectHypothesisTag("Use scrypt [hypothesis: C]"), "C");
});

test("detectHypothesisTag — case-insensitive on the keyword", () => {
  assert.equal(detectHypothesisTag("[Hypothesis: B] some todo"), "B");
  assert.equal(detectHypothesisTag("[HYPOTHESIS: D] another"), "D");
});

test("detectHypothesisTag — accepts longer tokens", () => {
  assert.equal(
    detectHypothesisTag("[hypothesis: bcrypt-route] do thing"),
    "bcrypt-route",
  );
});

test("detectHypothesisTag — null on missing tag", () => {
  assert.equal(detectHypothesisTag("Just a regular todo"), null);
  assert.equal(detectHypothesisTag(""), null);
});

test("detectHypothesisTag — null on malformed tag (empty token)", () => {
  assert.equal(detectHypothesisTag("[hypothesis:   ]"), null);
});

test("assignHypothesisGroups — empty input returns empty groups", () => {
  const got = assignHypothesisGroups([]);
  assert.equal(got.todoIdToGroupId.size, 0);
  assert.deepEqual(got.groupIds, []);
});

test("assignHypothesisGroups — no hypothesis tags → no group assigned", () => {
  const got = assignHypothesisGroups([
    { id: "t1", description: "Just do the thing" },
    { id: "t2", description: "Another regular todo" },
  ]);
  assert.equal(got.todoIdToGroupId.size, 0);
  assert.deepEqual(got.groupIds, []);
});

test("assignHypothesisGroups — all hypothesis-tagged todos in one batch share ONE groupId", () => {
  const got = assignHypothesisGroups([
    { id: "t1", description: "[hypothesis: A] try bcrypt" },
    { id: "t2", description: "[hypothesis: B] try argon2" },
    { id: "t3", description: "[hypothesis: C] try scrypt" },
  ]);
  assert.equal(got.todoIdToGroupId.size, 3);
  assert.equal(got.groupIds.length, 1);
  // All three should share the same group id
  const g1 = got.todoIdToGroupId.get("t1");
  const g2 = got.todoIdToGroupId.get("t2");
  const g3 = got.todoIdToGroupId.get("t3");
  assert.ok(g1);
  assert.equal(g1, g2);
  assert.equal(g1, g3);
});

test("assignHypothesisGroups — mixed hypothesis + regular todos: only hypothesis ones get grouped", () => {
  const got = assignHypothesisGroups([
    { id: "regular-1", description: "Just do this" },
    { id: "alt-A", description: "[hypothesis: A] one approach" },
    { id: "regular-2", description: "Also do this" },
    { id: "alt-B", description: "[hypothesis: B] another approach" },
  ]);
  assert.equal(got.todoIdToGroupId.size, 2);
  assert.equal(got.todoIdToGroupId.has("regular-1"), false);
  assert.equal(got.todoIdToGroupId.has("regular-2"), false);
  assert.ok(got.todoIdToGroupId.get("alt-A"));
  assert.equal(
    got.todoIdToGroupId.get("alt-A"),
    got.todoIdToGroupId.get("alt-B"),
  );
});

test("assignHypothesisGroups — different cycles get different groupIds", () => {
  const c1 = assignHypothesisGroups([
    { id: "a", description: "[hypothesis: A] x" },
  ]);
  const c2 = assignHypothesisGroups([
    { id: "b", description: "[hypothesis: A] y" },
  ]);
  // Two separate calls (separate planner cycles) → distinct group ids
  assert.notEqual(c1.todoIdToGroupId.get("a"), c2.todoIdToGroupId.get("b"));
});

test("expectedFilesOverlap — true when both share at least one file", () => {
  assert.ok(expectedFilesOverlap(["src/a.ts", "src/b.ts"], ["src/b.ts"]));
});

test("expectedFilesOverlap — false on disjoint sets", () => {
  assert.equal(
    expectedFilesOverlap(["src/a.ts"], ["src/b.ts", "src/c.ts"]),
    false,
  );
});

test("expectedFilesOverlap — false when either side empty", () => {
  assert.equal(expectedFilesOverlap([], ["src/a.ts"]), false);
  assert.equal(expectedFilesOverlap(["src/a.ts"], []), false);
  assert.equal(expectedFilesOverlap([], []), false);
});

test("expectedFilesOverlap — duplicate within one side doesn't false-positive", () => {
  assert.equal(
    expectedFilesOverlap(["src/a.ts", "src/a.ts"], ["src/b.ts"]),
    false,
  );
});

// T-Item-HypTimeout (2026-05-04): conflict-detection deferral timeout
function cand(
  id: string,
  groupId: string | null,
  files: string[],
  status: CandidateForConflict["status"] = "pending",
): CandidateForConflict {
  return { id, groupId, expectedFiles: files, status };
}

test("evaluateConflictDispatch — non-pending candidate → defer", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"], "in-progress"),
    groupSiblings: [],
    deferralTimestamps: new Map(),
    now: 1000,
  });
  assert.equal(verdict, "defer");
});

test("evaluateConflictDispatch — pending with no group → dispatch", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", null, ["a.ts"]),
    groupSiblings: [cand("t2", "g1", ["a.ts"], "in-progress")],
    deferralTimestamps: new Map(),
    now: 1000,
  });
  assert.equal(verdict, "dispatch");
});

test("evaluateConflictDispatch — group with no in-progress siblings → dispatch", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"]),
    groupSiblings: [cand("t2", "g1", ["a.ts"], "pending")],
    deferralTimestamps: new Map(),
    now: 1000,
  });
  assert.equal(verdict, "dispatch");
});

test("evaluateConflictDispatch — in-progress sibling with disjoint files → dispatch", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"]),
    groupSiblings: [cand("t2", "g1", ["b.ts"], "in-progress")],
    deferralTimestamps: new Map(),
    now: 1000,
  });
  assert.equal(verdict, "dispatch");
});

test("evaluateConflictDispatch — overlap with in-progress sibling → defer (no prior timestamp)", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"]),
    groupSiblings: [cand("t2", "g1", ["a.ts"], "in-progress")],
    deferralTimestamps: new Map(),
    now: 1000,
  });
  assert.equal(verdict, "defer");
});

test("evaluateConflictDispatch — overlap + recent first-deferred → still defer", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"]),
    groupSiblings: [cand("t2", "g1", ["a.ts"], "in-progress")],
    deferralTimestamps: new Map([["t1", 1000]]),
    now: 1000 + (CONFLICT_DEFERRAL_MAX_MS - 1),
  });
  assert.equal(verdict, "defer");
});

test("evaluateConflictDispatch — overlap + first-deferred ≥ MAX_MS ago → force-dispatch", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"]),
    groupSiblings: [cand("t2", "g1", ["a.ts"], "in-progress")],
    deferralTimestamps: new Map([["t1", 1000]]),
    now: 1000 + CONFLICT_DEFERRAL_MAX_MS,
  });
  assert.equal(verdict, "force-dispatch");
});

test("evaluateConflictDispatch — sibling in DIFFERENT group does not trigger conflict", () => {
  const verdict = evaluateConflictDispatch({
    candidate: cand("t1", "g1", ["a.ts"]),
    groupSiblings: [cand("t2", "g2", ["a.ts"], "in-progress")],
    deferralTimestamps: new Map(),
    now: 1000,
  });
  assert.equal(verdict, "dispatch");
});

test("updateDeferralTimestamps — defer adds new entry", () => {
  const next = updateDeferralTimestamps({
    candidateId: "t1",
    verdict: "defer",
    current: new Map(),
    now: 1000,
  });
  assert.equal(next.get("t1"), 1000);
});

test("updateDeferralTimestamps — defer preserves existing first-deferred timestamp", () => {
  const next = updateDeferralTimestamps({
    candidateId: "t1",
    verdict: "defer",
    current: new Map([["t1", 500]]),
    now: 9999,
  });
  assert.equal(next.get("t1"), 500);
});

test("updateDeferralTimestamps — dispatch removes the entry", () => {
  const next = updateDeferralTimestamps({
    candidateId: "t1",
    verdict: "dispatch",
    current: new Map([["t1", 500]]),
    now: 1000,
  });
  assert.equal(next.has("t1"), false);
});

test("updateDeferralTimestamps — force-dispatch removes the entry too", () => {
  const next = updateDeferralTimestamps({
    candidateId: "t1",
    verdict: "force-dispatch",
    current: new Map([["t1", 500]]),
    now: 1000,
  });
  assert.equal(next.has("t1"), false);
});

test("updateDeferralTimestamps — does not mutate input map", () => {
  const original = new Map([["t1", 500]]);
  updateDeferralTimestamps({
    candidateId: "t1",
    verdict: "dispatch",
    current: original,
    now: 1000,
  });
  // Original should still have the entry
  assert.equal(original.get("t1"), 500);
});
