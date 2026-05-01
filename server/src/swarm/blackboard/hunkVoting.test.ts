import { test } from "node:test";
import assert from "node:assert/strict";
import { voteOnHunks, type HunkVote } from "./hunkVoting.js";
import type { Hunk } from "./applyHunks.js";

const REPLACE = "replace" as const;

function vote(workerId: string, hunks: Hunk[]): HunkVote {
  return { workerId, hunks };
}

const HUNK_A: Hunk = { op: REPLACE, file: "src/x.ts", search: "old", replace: "new" };
const HUNK_B: Hunk = { op: REPLACE, file: "src/x.ts", search: "old", replace: "different" };
const HUNK_C: Hunk = { op: REPLACE, file: "src/y.ts", search: "foo", replace: "bar" };

test("voteOnHunks — unanimous K=3 returns winner with full agreement", () => {
  const result = voteOnHunks([
    vote("w1", [HUNK_A]),
    vote("w2", [HUNK_A]),
    vote("w3", [HUNK_A]),
  ]);
  assert.deepEqual(result.winner, [HUNK_A]);
  assert.equal(result.agreementCount, 3);
  assert.equal(result.totalConsidered, 3);
  assert.equal(result.distinctShapes, 1);
  assert.equal(result.unanimous, true);
  assert.equal(result.hasMajority, true);
  assert.deepEqual(result.agreedWorkers.sort(), ["w1", "w2", "w3"]);
});

test("voteOnHunks — split K=3 (2 vs 1) majority wins", () => {
  const result = voteOnHunks([
    vote("w1", [HUNK_A]),
    vote("w2", [HUNK_A]),
    vote("w3", [HUNK_B]),
  ]);
  assert.deepEqual(result.winner, [HUNK_A]);
  assert.equal(result.agreementCount, 2);
  assert.equal(result.totalConsidered, 3);
  assert.equal(result.distinctShapes, 2);
  assert.equal(result.unanimous, false);
  assert.equal(result.hasMajority, true);
  assert.deepEqual(result.agreedWorkers.sort(), ["w1", "w2"]);
});

test("voteOnHunks — three-way split K=3 → lexical-first tiebreak", () => {
  const result = voteOnHunks([
    vote("w1", [HUNK_A]),
    vote("w2", [HUNK_B]),
    vote("w3", [HUNK_C]),
  ]);
  // All three buckets have count=1; tiebreak picks the lexically-first
  // hash. We don't assert WHICH hunk wins (that's an implementation
  // detail of the hash function), just that:
  // - some winner is returned
  // - agreementCount=1, totalConsidered=3
  // - hasMajority=false, tiebreak="lexical-first"
  assert.notEqual(result.winner, null);
  assert.equal(result.agreementCount, 1);
  assert.equal(result.totalConsidered, 3);
  assert.equal(result.distinctShapes, 3);
  assert.equal(result.unanimous, false);
  assert.equal(result.hasMajority, false);
  assert.equal(result.tiebreak, "lexical-first");
});

test("voteOnHunks — empty input returns null winner", () => {
  const result = voteOnHunks([]);
  assert.equal(result.winner, null);
  assert.equal(result.totalConsidered, 0);
  assert.equal(result.unanimous, false);
});

test("voteOnHunks — votes with empty hunks arrays don't dilute the denominator", () => {
  const result = voteOnHunks([
    vote("w1", [HUNK_A]),
    vote("w2", [HUNK_A]),
    vote("w3", []), // worker bailed
  ]);
  assert.deepEqual(result.winner, [HUNK_A]);
  assert.equal(result.agreementCount, 2);
  assert.equal(result.totalConsidered, 2, "empty-hunks vote excluded from denominator");
  assert.equal(result.unanimous, true, "2/2 eligible = unanimous");
});

test("voteOnHunks — whitespace-only differences count as agreement", () => {
  const a: Hunk = { op: REPLACE, file: "src/x.ts", search: "old\n", replace: "new" };
  const b: Hunk = { op: REPLACE, file: "src/x.ts", search: "old", replace: "new   " };
  const c: Hunk = { op: REPLACE, file: "src/x.ts", search: "old\r\n", replace: "new" };
  const result = voteOnHunks([vote("w1", [a]), vote("w2", [b]), vote("w3", [c])]);
  assert.equal(result.agreementCount, 3, "whitespace-trimmed hunks should count as the same vote");
  assert.equal(result.unanimous, true);
});

test("voteOnHunks — different files counted as different shapes even with same search/replace", () => {
  const result = voteOnHunks([
    vote("w1", [{ op: REPLACE, file: "a.ts", search: "x", replace: "y" }]),
    vote("w2", [{ op: REPLACE, file: "b.ts", search: "x", replace: "y" }]),
  ]);
  assert.equal(result.distinctShapes, 2);
  assert.equal(result.hasMajority, false);
});

test("voteOnHunks — multi-hunk envelopes vote as units, not per-hunk", () => {
  // w1 + w2 share hunk A but disagree on the second; w3 has only hunk A.
  // No envelope-level majority exists.
  const result = voteOnHunks([
    vote("w1", [HUNK_A, HUNK_B]),
    vote("w2", [HUNK_A, HUNK_C]),
    vote("w3", [HUNK_A]),
  ]);
  assert.equal(result.distinctShapes, 3, "envelope-level voting, not per-hunk");
  assert.equal(result.hasMajority, false);
});
