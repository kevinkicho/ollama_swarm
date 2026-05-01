import { test } from "node:test";
import assert from "node:assert/strict";
import { voteOnHunks, voteOnHunksWithJudge, type HunkVote, type JudgeFn } from "./hunkVoting.js";
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

// #92 (2026-05-01): LLM-as-judge tiebreak tests.

test("voteOnHunksWithJudge — judge picks the winner when no majority", async () => {
  const judge: JudgeFn = async (candidates) => {
    // Pick the one with file y.ts (deterministic for the test)
    const yCandidate = candidates.find((c) => c.hunks.some((h) => h.file === "src/y.ts"));
    return yCandidate ? yCandidate.id : null;
  };
  const result = await voteOnHunksWithJudge(
    [vote("w1", [HUNK_A]), vote("w2", [HUNK_B]), vote("w3", [HUNK_C])],
    judge,
  );
  assert.deepEqual(result.winner, [HUNK_C]);
  assert.equal(result.tiebreak, "llm-judge");
  assert.equal(result.hasMajority, false);
  assert.equal(result.agreementCount, 1, "winner had 1 worker (HUNK_C / w3)");
  assert.deepEqual(result.agreedWorkers, ["w3"]);
});

test("voteOnHunksWithJudge — judge skipped entirely when there's a strict majority", async () => {
  let judgeCalled = false;
  const judge: JudgeFn = async () => {
    judgeCalled = true;
    return null;
  };
  const result = await voteOnHunksWithJudge(
    [vote("w1", [HUNK_A]), vote("w2", [HUNK_A]), vote("w3", [HUNK_B])],
    judge,
  );
  assert.deepEqual(result.winner, [HUNK_A]);
  assert.equal(result.tiebreak, "none", "majority case skips the judge");
  assert.equal(judgeCalled, false, "judge must NOT be called when majority exists");
});

test("voteOnHunksWithJudge — judge returns null → lexical-first fallback", async () => {
  const judge: JudgeFn = async () => null;
  const result = await voteOnHunksWithJudge(
    [vote("w1", [HUNK_A]), vote("w2", [HUNK_B]), vote("w3", [HUNK_C])],
    judge,
  );
  assert.equal(result.tiebreak, "llm-judge-failed-fallback-lexical");
  assert.notEqual(result.winner, null, "fallback still produces a winner");
});

test("voteOnHunksWithJudge — judge returns invalid id → lexical-first fallback", async () => {
  const judge: JudgeFn = async () => "not-a-real-candidate-id";
  const result = await voteOnHunksWithJudge(
    [vote("w1", [HUNK_A]), vote("w2", [HUNK_B]), vote("w3", [HUNK_C])],
    judge,
  );
  assert.equal(result.tiebreak, "llm-judge-failed-fallback-lexical");
  assert.notEqual(result.winner, null);
});

test("voteOnHunksWithJudge — judge throws → lexical-first fallback", async () => {
  const judge: JudgeFn = async () => {
    throw new Error("LLM API failed");
  };
  const result = await voteOnHunksWithJudge(
    [vote("w1", [HUNK_A]), vote("w2", [HUNK_B]), vote("w3", [HUNK_C])],
    judge,
  );
  assert.equal(result.tiebreak, "llm-judge-failed-fallback-lexical");
  assert.notEqual(result.winner, null, "exception still produces a winner");
});

test("voteOnHunksWithJudge — judge sees all candidates with workerIds populated", async () => {
  let candidatesSeen: any = null;
  const judge: JudgeFn = async (candidates) => {
    candidatesSeen = candidates;
    return candidates[0].id;
  };
  await voteOnHunksWithJudge(
    [
      vote("w1", [HUNK_A]),
      vote("w2", [HUNK_A]),
      vote("w3", [HUNK_B]),
      vote("w4", [HUNK_B]),
      vote("w5", [HUNK_C]),
    ],
    judge,
  );
  assert.equal(candidatesSeen.length, 3);
  // Sorted highest-count first, lexical-tiebreak. HUNK_A and HUNK_B both
  // have 2 workers; one will be position 0.
  const totalWorkers = candidatesSeen.reduce((sum: number, c: any) => sum + c.workerIds.length, 0);
  assert.equal(totalWorkers, 5);
});
