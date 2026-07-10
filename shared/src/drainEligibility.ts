/** Drain is available for soft-stop once a run has started (not only mid-execution). */

export interface DrainEligibilityInput {
  phase: string;
  claimed: number;
  pendingCommit: number;
  replanPending?: number;
  replanRunning?: boolean;
  workerThinking?: boolean;
}

/** Terminal / not-yet-started phases — Drain is a no-op (use Stop only when active stop is available). */
const NO_DRAIN_PHASES = new Set<string>([
  "idle",
  "stopped",
  "stopping",
  "completed",
  "failed",
]);

/**
 * Soft-stop is available for any live run phase, including early seeding/cloning.
 * Finish in-flight work when present; otherwise controlled soft exit vs hard Stop.
 * (User can always escalate with hard Stop.)
 */
export function isDrainEligible(input: DrainEligibilityInput): boolean {
  if (input.claimed > 0) return true;
  if (input.pendingCommit > 0) return true;
  if ((input.replanPending ?? 0) > 0) return true;
  if (input.replanRunning) return true;
  if (input.workerThinking) return true;
  if (NO_DRAIN_PHASES.has(input.phase)) return false;
  // Any other phase (cloning, spawning, seeding, discussing, planning, executing, …)
  return true;
}

export function drainIneligibleReason(input: DrainEligibilityInput): string {
  if (NO_DRAIN_PHASES.has(input.phase)) {
    return `phase=${input.phase} (run not active — Drain unavailable)`;
  }
  if (!isDrainEligible(input)) {
    return "drain not applicable";
  }
  return "drain not applicable";
}
