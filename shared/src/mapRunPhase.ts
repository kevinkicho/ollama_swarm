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
 * Prefer V2 for terminal + pause, and for mid-flight core phases when V2
 * is already past spawning (reduces V1 flag lag on blackboard).
 * Legacy UI-only phases (cloning/seeding/discussing/stopping) stay on V1
 * when V2 has not entered a mapped phase yet.
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
  const midFlight: RunPhase[] = ["spawning", "planning", "executing", "auditing", "tier-up"];
  if (midFlight.includes(v2.phase)) {
    // Prefer V2 mid-flight over lagging V1 "planning" while V2 is already "executing", etc.
    const v1IsLegacyOnly = ["cloning", "seeding", "discussing", "stopping"].includes(v1Phase);
    if (!v1IsLegacyOnly || v2.phase !== "spawning") {
      return mapV2PhaseToUi(v2.phase);
    }
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
