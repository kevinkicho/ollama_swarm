// #87 (2026-05-01): self-consistency voting for worker hunks.
//
// When a single worker's hunk is wrong (search-not-unique, dropped
// context, syntactic noise), the run loses 1 commit + restart cost.
// Self-consistency: K workers propose hunks for the SAME todo
// independently; we group their proposals by normalized content and
// commit the majority winner. Reproduces the test-time-compute pattern
// from research (Wang et al., "Self-consistency improves chain of
// thought reasoning" — same idea applied to code edits).
//
// Voting is over the FULL hunks array per envelope (not per-hunk),
// since worker envelopes are atomic units the runner applies
// transactionally. Two envelopes that share K-1 hunks but differ on the
// Kth are NOT counted as agreement.

import type { Hunk } from "./applyHunks.js";

export interface HunkVote {
  /** The hunks array as parsed from one worker's response. */
  hunks: readonly Hunk[];
  /** Source worker id — kept for diagnostics + tiebreak attribution. */
  workerId: string;
}

export interface VoteResult {
  /** The winning hunks array, or null if no votes had hunks. */
  winner: readonly Hunk[] | null;
  /** Number of votes that matched the winner (after normalization). */
  agreementCount: number;
  /** Total votes considered (= input count, minus empty-hunks votes). */
  totalConsidered: number;
  /** Distinct distinct envelope shapes seen — diagnostic. */
  distinctShapes: number;
  /** Worker ids whose envelope matched the winner. */
  agreedWorkers: string[];
  /** When agreementCount === totalConsidered = unanimous. */
  unanimous: boolean;
  /** True when the winning shape had a strict plurality (> any other). */
  hasMajority: boolean;
  /** Tiebreak path taken when no strict majority — diagnostic. */
  tiebreak: "none" | "lexical-first" | "llm-judge" | "llm-judge-failed-fallback-lexical";
}

/** Candidate shape passed to a judgeFn when no strict majority exists.
 *  Each entry represents one distinct envelope shape (de-duped) with
 *  the workerIds that voted for it. */
export interface JudgeCandidate {
  /** Stable id (the same hash voteOnHunks uses internally). Pass this
   *  back as the winner from judgeFn. */
  id: string;
  hunks: readonly Hunk[];
  workerIds: string[];
}

/** Optional async judge — called ONLY when there's no strict majority.
 *  Should return the candidate id that wins (one of the candidates'
 *  `id` fields), or null to fall back to lexical-first. */
export type JudgeFn = (candidates: readonly JudgeCandidate[]) => Promise<string | null>;

/** Normalize a hunk for hashing: trim whitespace, fold consecutive
 *  spaces, normalize line endings. Two hunks that differ only in
 *  trailing whitespace or line-ending style count as the same vote. */
function normalizeHunkText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/** Stable hash for a hunks-envelope. Joins the per-hunk fields with
 *  unambiguous separators so {file: "a.ts", search: "x"} doesn't hash
 *  to the same value as {file: "a", search: ":x"}. */
function hashHunks(hunks: readonly Hunk[]): string {
  const parts: string[] = [];
  for (const h of hunks) {
    parts.push(`OP=${h.op}`);
    parts.push(`FILE=${h.file}`);
    if (h.op === "replace") {
      parts.push(`SEARCH=${normalizeHunkText(h.search)}`);
      parts.push(`REPLACE=${normalizeHunkText(h.replace)}`);
    } else if (h.op === "delete") {
      parts.push(`CONTENT=`);
    } else {
      // create / append both carry `content`
      parts.push(`CONTENT=${normalizeHunkText((h as { content: string }).content)}`);
    }
    parts.push("---");
  }
  return parts.join("\n");
}

export function voteOnHunks(votes: readonly HunkVote[]): VoteResult {
  return voteOnHunksImpl(votes, null);
}

/** Async variant — when no strict majority, calls judgeFn (typically
 *  an LLM) to pick the winner among candidates. Falls back to
 *  lexical-first if judgeFn returns null or throws. */
export async function voteOnHunksWithJudge(
  votes: readonly HunkVote[],
  judgeFn: JudgeFn,
): Promise<VoteResult> {
  return voteOnHunksImpl(votes, judgeFn);
}

async function voteOnHunksImpl(
  votes: readonly HunkVote[],
  judgeFn: JudgeFn | null,
): Promise<VoteResult>;
function voteOnHunksImpl(
  votes: readonly HunkVote[],
  judgeFn: null,
): VoteResult;
function voteOnHunksImpl(
  votes: readonly HunkVote[],
  judgeFn: JudgeFn | null,
): VoteResult | Promise<VoteResult> {
  // Empty / no-hunks votes don't count toward the denominator. A worker
  // that returned `{hunks: []}` is signalling "I don't know how to do
  // this" and shouldn't pull the consensus toward 0.
  const eligible = votes.filter((v) => v.hunks.length > 0);
  if (eligible.length === 0) {
    return {
      winner: null,
      agreementCount: 0,
      totalConsidered: 0,
      distinctShapes: 0,
      agreedWorkers: [],
      unanimous: false,
      hasMajority: false,
      tiebreak: "none",
    };
  }

  // Bucket by hashed envelope.
  const buckets = new Map<string, { hunks: readonly Hunk[]; workers: string[] }>();
  for (const v of eligible) {
    const h = hashHunks(v.hunks);
    const existing = buckets.get(h);
    if (existing) {
      existing.workers.push(v.workerId);
    } else {
      buckets.set(h, { hunks: v.hunks, workers: [v.workerId] });
    }
  }

  // Sort buckets: highest count first; tie → lexically-first hash.
  const sorted = [...buckets.entries()].sort((a, b) => {
    if (a[1].workers.length !== b[1].workers.length) {
      return b[1].workers.length - a[1].workers.length;
    }
    return a[0].localeCompare(b[0]);
  });

  const top = sorted[0];
  const topCount = top[1].workers.length;
  const second = sorted[1];
  const hasMajority = !second || topCount > second[1].workers.length;
  const unanimous = topCount === eligible.length;

  // Strict-majority case — no need to call the judge, just return.
  if (hasMajority) {
    return {
      winner: top[1].hunks,
      agreementCount: topCount,
      totalConsidered: eligible.length,
      distinctShapes: buckets.size,
      agreedWorkers: top[1].workers,
      unanimous,
      hasMajority: true,
      tiebreak: "none",
    };
  }

  // No-majority case + no judge → lexical-first (sync path).
  if (judgeFn === null) {
    return {
      winner: top[1].hunks,
      agreementCount: topCount,
      totalConsidered: eligible.length,
      distinctShapes: buckets.size,
      agreedWorkers: top[1].workers,
      unanimous: false,
      hasMajority: false,
      tiebreak: "lexical-first",
    };
  }

  // No-majority case + judge → consult the judge async.
  const candidates: JudgeCandidate[] = sorted.map(([id, b]) => ({
    id,
    hunks: b.hunks,
    workerIds: b.workers,
  }));
  return Promise.resolve(judgeFn(candidates))
    .then((winnerId) => {
      if (winnerId === null) {
        // Judge declined → lexical-first fallback.
        return {
          winner: top[1].hunks,
          agreementCount: topCount,
          totalConsidered: eligible.length,
          distinctShapes: buckets.size,
          agreedWorkers: top[1].workers,
          unanimous: false,
          hasMajority: false,
          tiebreak: "llm-judge-failed-fallback-lexical" as const,
        };
      }
      const judgeWinner = buckets.get(winnerId);
      if (!judgeWinner) {
        // Judge returned a non-candidate id → lexical-first fallback.
        return {
          winner: top[1].hunks,
          agreementCount: topCount,
          totalConsidered: eligible.length,
          distinctShapes: buckets.size,
          agreedWorkers: top[1].workers,
          unanimous: false,
          hasMajority: false,
          tiebreak: "llm-judge-failed-fallback-lexical" as const,
        };
      }
      return {
        winner: judgeWinner.hunks,
        agreementCount: judgeWinner.workers.length,
        totalConsidered: eligible.length,
        distinctShapes: buckets.size,
        agreedWorkers: judgeWinner.workers,
        unanimous: false,
        hasMajority: false,
        tiebreak: "llm-judge" as const,
      };
    })
    .catch(() => {
      // Judge threw → lexical-first fallback.
      return {
        winner: top[1].hunks,
        agreementCount: topCount,
        totalConsidered: eligible.length,
        distinctShapes: buckets.size,
        agreedWorkers: top[1].workers,
        unanimous: false,
        hasMajority: false,
        tiebreak: "llm-judge-failed-fallback-lexical" as const,
      };
    });
}
