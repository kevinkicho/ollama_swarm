/** Drain is only meaningful when worker execution has in-flight work to preserve. */

export interface DrainEligibilityInput {
  phase: string;
  claimed: number;
  pendingCommit: number;
  replanPending?: number;
  replanRunning?: boolean;
  workerThinking?: boolean;
}

const NON_EXEC_PHASES = new Set<string>([
  "idle",
  "cloning",
  "spawning",
  "booting",
  "seeding",
  "planning",
  "discussing",
  "auditing",
]);

export function isDrainEligible(input: DrainEligibilityInput): boolean {
  if (input.claimed > 0) return true;
  if (input.pendingCommit > 0) return true;
  if (NON_EXEC_PHASES.has(input.phase)) return false;
  if (input.phase !== "executing" && input.phase !== "paused" && input.phase !== "draining") {
    return false;
  }
  if ((input.replanPending ?? 0) > 0) return true;
  if (input.replanRunning) return true;
  if (input.workerThinking) return true;
  return false;
}

export function drainIneligibleReason(input: DrainEligibilityInput): string {
  if (NON_EXEC_PHASES.has(input.phase)) {
    if (input.workerThinking && input.phase === "auditing") {
      return "phase=auditing (lead-agent audit in progress — Drain only applies to worker todos; use Stop)";
    }
    if (input.workerThinking && (input.phase === "discussing" || input.phase === "seeding")) {
      return `phase=${input.phase} (council planning/discussion — use Stop; Drain enables during executing when workers have claims)`;
    }
    return `phase=${input.phase} (no worker claims yet — use Stop for immediate exit)`;
  }
  if (input.claimed === 0 && input.pendingCommit === 0) {
    return "no in-flight worker claims or pending commits";
  }
  return "drain not applicable";
}