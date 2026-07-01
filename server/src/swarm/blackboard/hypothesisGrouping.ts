// T-Item-3 (2026-05-04): hypothesis-tag detection + grouping for the
// in-flight parallel hypothesis lever.
//
// The planner is asked (via T198i + this lever) to emit alternative
// todos for unmet/partial criteria, tagged in their description like:
//   "[hypothesis: A] Use bcrypt for password hashing"
//   "[hypothesis: B] Use argon2 for password hashing"
//   "[hypothesis: C] Use scrypt for password hashing"
//
// Alternatives co-emitted in a single planner cycle are SIBLINGS in
// the same hypothesis group. The runner uses the group to:
//   - dispatch alternatives in PARALLEL (rather than sequentially)
//   - cross-cancel when one wins (commits successfully)
//   - serialize within group when expectedFiles overlap
//
// The detection regex is permissive: `[hypothesis: <token>]` where
// <token> is any non-bracket text. Single-letter tokens (A/B/C) are
// the canonical form but the parser accepts longer tokens too — the
// runner doesn't care about the token VALUE, only that hypothesis-
// tagged todos in the same cycle share a group.

import { randomUUID } from "node:crypto";

export interface PlannerTodoDescriptor {
  /** Stable id (the planner-assigned id, distinct from TodoQueue's
   *  post-assigned id). Used by the caller to map back from group
   *  membership to specific todos. */
  id: string;
  description: string;
}

export interface GroupAssignment {
  /** Map from planner todo id → groupId. Todos NOT in the map are
   *  unaffected (no hypothesis tag detected). */
  todoIdToGroupId: Map<string, string>;
  /** All distinct group ids assigned in this call. The caller spins up
   *  one AbortController per groupId. */
  groupIds: string[];
}

const HYPOTHESIS_RE = /\[hypothesis:\s*([^\]]+)\]/i;

/** Returns the hypothesis token (e.g. "A") when the description carries
 *  a `[hypothesis: X]` tag, else null. Token whitespace is trimmed. */
export function detectHypothesisTag(description: string): string | null {
  const m = description.match(HYPOTHESIS_RE);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/** Assign shared groupIds to hypothesis-tagged todos co-emitted in one
 *  planner cycle.
 *
 *  Grouping rule (per the T-Item-3 plan): all hypothesis-tagged todos
 *  in this batch share a SINGLE groupId. The planner is asked to emit
 *  alternatives as a GROUP (one cycle = one set of alternatives for
 *  one criterion); without per-criterion attribution we can't split
 *  multiple groups within a cycle, so we treat them as one group.
 *
 *  This is the conservative-correctness choice — false grouping (two
 *  unrelated alternative sets get merged) means cross-cancellation
 *  when one lands; missed grouping (alternatives don't share groupId)
 *  means they all run sequentially. The plan ships per-cycle grouping
 *  + defers per-criterion as a follow-up. */
export function assignHypothesisGroups(
  todos: readonly PlannerTodoDescriptor[],
): GroupAssignment {
  const todoIdToGroupId = new Map<string, string>();
  const groupIds: string[] = [];
  let cycleGroupId: string | null = null;
  for (const t of todos) {
    if (detectHypothesisTag(t.description) === null) continue;
    if (!cycleGroupId) {
      cycleGroupId = `hyp-${randomUUID().slice(0, 8)}`;
      groupIds.push(cycleGroupId);
    }
    todoIdToGroupId.set(t.id, cycleGroupId);
  }
  return { todoIdToGroupId, groupIds };
}

/** Conflict-detection helper: given an in-flight alternative + a
 *  candidate alternative in the same group, do their expectedFiles
 *  overlap? If yes, the candidate must defer (serialize within group)
 *  to avoid both alternatives racing on the same file's hash + losing
 *  to CAS. */
export function expectedFilesOverlap(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const setA = new Set(a);
  for (const f of b) {
    if (setA.has(f)) return true;
  }
  return false;
}

// T-Item-HypTimeout (2026-05-04): conflict-detection deferral with
// a force-dispatch timeout. Prevents the deadlock where every
// alternative in a hypothesis group blocks on overlapping files.
// After CONFLICT_DEFERRAL_MAX_MS of being blocked, a candidate is
// force-dispatched (skipping the conflict check) so the group
// makes forward progress. Pure helpers — exported for tests; the
// runner threads the deferralTimestamps Map across dispatch calls.

export const CONFLICT_DEFERRAL_MAX_MS = 5 * 60_000;

export interface CandidateForConflict {
  /** Stable id (e.g. TodoQueue.QueuedTodo.id). */
  id: string;
  /** Group membership; null when the todo isn't in a hypothesis group. */
  groupId: string | null;
  /** Files this candidate plans to modify (for overlap detection). */
  expectedFiles: readonly string[];
  /** Status — only "pending" candidates are eligible to dispatch.
   *  Other statuses (e.g. "in-progress") are tracked for conflict
   *  comparison but never dispatched. */
  status: "pending" | "in-progress" | "pending-commit" | "completed" | "failed" | "skipped";
}

/** Decide whether a candidate is dispatch-eligible RIGHT NOW. Returns:
 *   - "dispatch": no conflict; safe to dequeue
 *   - "defer": at least one in-progress alternative in the same group
 *     has overlapping expectedFiles; wait for it to settle
 *   - "force-dispatch": deferred for ≥ CONFLICT_DEFERRAL_MAX_MS;
 *     break the deadlock by dispatching anyway
 *
 *  When dispatch-eligible (or force-dispatched) the caller should
 *  REMOVE the candidate's id from deferralTimestamps to reset its
 *  timer for any future re-queue.
 *
 *  Pure — exported for tests; no I/O, no side effects. */
export function evaluateConflictDispatch(input: {
  candidate: CandidateForConflict;
  groupSiblings: readonly CandidateForConflict[];
  deferralTimestamps: ReadonlyMap<string, number>;
  now: number;
}): "dispatch" | "defer" | "force-dispatch" {
  const { candidate, groupSiblings, deferralTimestamps, now } = input;
  if (candidate.status !== "pending") return "defer";
  // No group → no conflict check needed; dispatch normally.
  if (!candidate.groupId) return "dispatch";
  // Find in-progress siblings in the same group with overlapping files.
  const conflicting = groupSiblings.filter(
    (s) =>
      s.id !== candidate.id &&
      s.groupId === candidate.groupId &&
      s.status === "in-progress" &&
      expectedFilesOverlap(s.expectedFiles, candidate.expectedFiles),
  );
  if (conflicting.length === 0) return "dispatch";
  // Conflict detected. Check the timeout.
  const firstDeferred = deferralTimestamps.get(candidate.id);
  if (firstDeferred === undefined) return "defer";
  if (now - firstDeferred >= CONFLICT_DEFERRAL_MAX_MS) {
    return "force-dispatch";
  }
  return "defer";
}

/** Update the deferral-timestamp map after a dispatch evaluation.
 *  Call this whether the verdict was dispatch / defer / force-dispatch:
 *   - dispatch / force-dispatch → DELETE the candidate's id (reset)
 *   - defer → insert if absent (start the clock); leave existing
 *     timestamp alone (preserve the original "first deferred at")
 *
 *  Pure — returns a new Map; doesn't mutate the input. */
export function updateDeferralTimestamps(input: {
  candidateId: string;
  verdict: "dispatch" | "defer" | "force-dispatch";
  current: ReadonlyMap<string, number>;
  now: number;
}): Map<string, number> {
  const next = new Map(input.current);
  if (input.verdict === "defer") {
    if (!next.has(input.candidateId)) next.set(input.candidateId, input.now);
  } else {
    next.delete(input.candidateId);
  }
  return next;
}
