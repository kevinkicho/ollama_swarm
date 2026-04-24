// Unit 59 (59a — static per-worker role): when cfg.specializedWorkers
// is true, each worker is assigned a deliberately-different "bias"
// from this catalog. The worker's system prompt is prepended with the
// role guidance so the same todo, claimed by different workers,
// produces diffs with different qualities.
//
// Design intent (from MetaGPT / ChatDev / AutoGen research):
// heterogeneous worker roles outperform a flat worker pool on coding
// tasks. We're applying the same idea inside the blackboard preset's
// CAS-parallel pattern — each role's bias compounds with the
// planner's todo decomposition to produce more diverse diffs across
// the run.
//
// Roles are diff-oriented (NOT discussion roles like the role-diff
// preset uses). Three core biases cover the meaningful axes for
// commit-time decisions:
//
// - correctness: bias toward edge cases, validation, error handling
// - simplicity:  bias toward minimal diff, YAGNI, no incidental change
// - consistency: bias toward matching existing patterns + naming
//
// More than 3 workers cycle through these roles (worker-4 →
// correctness again, etc.). The cycling is deterministic so a
// resume run sees stable role assignment.

export interface WorkerRole {
  name: string;
  /** Prompt fragment prepended to WORKER_SYSTEM_PROMPT before the rules. */
  guidance: string;
}

export const WORKER_ROLE_CATALOG: readonly WorkerRole[] = [
  {
    name: "correctness",
    guidance:
      "ROLE BIAS — CORRECTNESS. When implementing this todo, weight " +
      "edge cases, input validation, and error-handling paths heavily. " +
      "If the implementation could fail on null / empty / malformed input, " +
      "your hunks should handle that explicitly. Prefer defensive over " +
      "assumed-happy-path code. If a related callsite already uses defensive " +
      "patterns, mirror them.",
  },
  {
    name: "simplicity",
    guidance:
      "ROLE BIAS — SIMPLICITY. When implementing this todo, weight a " +
      "minimal diff heavily. Do NOT change adjacent code that already works, " +
      "even if you'd phrase it differently. Avoid adding helpers, abstractions, " +
      "or comments unless the todo specifically requires them. The smallest " +
      "diff that satisfies the todo description wins.",
  },
  {
    name: "consistency",
    guidance:
      "ROLE BIAS — CONSISTENCY. When implementing this todo, weight " +
      "matching the existing codebase's style heavily. Use the same naming " +
      "conventions, indentation, error-handling idioms, and import patterns " +
      "as the surrounding files. If you see two patterns in the codebase, " +
      "pick the one used in files closest to the one you're editing.",
  },
];

/**
 * Deterministic role assignment for worker N (1-based — worker-2 is the
 * first worker, since agent-1 is the planner). Returns the role from
 * WORKER_ROLE_CATALOG, cycling for N > catalog.length.
 *
 * Pure: same workerIndex → same role across runs and across
 * resume cycles, so the user can predict what each worker is biased
 * toward by reading the agent index.
 */
export function assignWorkerRole(workerOrdinal: number): WorkerRole {
  // workerOrdinal is 1-based (first worker = 1). Map to 0-based and
  // cycle through the catalog.
  const idx = (Math.max(1, workerOrdinal) - 1) % WORKER_ROLE_CATALOG.length;
  return WORKER_ROLE_CATALOG[idx]!;
}
