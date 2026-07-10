/**
 * Map V2 pure run-state machine phases → SwarmStatus `phase` strings used by UI.
 * Phase 4 (release 1.0): partial promotion of V2 as SoT for terminal + pause.
 */

import type { RunPhase, RunState } from "./runStateMachine.js";

/** UI / status phase vocabulary (superset of RunPhase). */
export type SwarmUiPhase =
  | "idle"
  | "spawning"
  | "cloning"
  | "seeding"
  | "planning"
  | "executing"
  | "auditing"
  | "tier-up"
  | "discussing"
  | "draining"
  | "stopping"
  | "paused"
  | "completed"
  | "stopped"
  | "failed";

const V2_TO_UI: Record<RunPhase, SwarmUiPhase> = {
  idle: "idle",
  spawning: "spawning",
  planning: "planning",
  executing: "executing",
  auditing: "auditing",
  "tier-up": "tier-up",
  draining: "draining",
  completed: "completed",
  stopped: "stopped",
  failed: "failed",
};

export function mapV2PhaseToUi(phase: RunPhase): SwarmUiPhase {
  return V2_TO_UI[phase] ?? "idle";
}

/**
 * Prefer V2 for terminal + pause when V1 lag would mis-report.
 * Mid-flight phases still trust V1 until full cutover (Phase 4 full).
 */
export function resolveDisplayPhase(
  v1Phase: string,
  v2: Pick<RunState, "phase" | "pausedReason">,
): SwarmUiPhase {
  if (v2.pausedReason && v1Phase !== "stopped" && v1Phase !== "failed" && v1Phase !== "completed") {
    return "paused";
  }
  const terminal: RunPhase[] = ["completed", "stopped", "failed", "draining"];
  if (terminal.includes(v2.phase)) {
    return mapV2PhaseToUi(v2.phase);
  }
  return (v1Phase as SwarmUiPhase) || "idle";
}

/** True when V1 and V2 disagree on terminal-ish phase (for tests / diagnostics). */
export function phasesDiverge(v1Phase: string, v2Phase: RunPhase): boolean {
  const v1Term = ["completed", "stopped", "failed", "draining", "paused"].includes(v1Phase);
  const v2Term = ["completed", "stopped", "failed", "draining"].includes(v2Phase);
  if (v1Term || v2Term) {
    return mapV2PhaseToUi(v2Phase) !== v1Phase && !(v1Phase === "paused" && v2Phase === "executing");
  }
  return false;
}
