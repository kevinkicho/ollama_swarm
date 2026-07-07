import type { SwarmPhase } from "../types";

const TERMINAL: ReadonlySet<SwarmPhase> = new Set([
  "stopped",
  "completed",
  "failed",
]);

/** True when the run has ended (or is ending). */
export function isTerminalSwarmPhase(phase: SwarmPhase | undefined): boolean {
  if (!phase) return false;
  return TERMINAL.has(phase);
}

/** True while agents may still be working (includes cloning/spawning/etc.). */
export function isActiveSwarmPhase(phase: SwarmPhase | undefined): boolean {
  if (!phase || phase === "idle") return false;
  return !isTerminalSwarmPhase(phase);
}

/** Collapse granular runner phases to a simple UI label. */
export function displaySwarmPhase(phase: SwarmPhase | undefined): string {
  if (!phase || phase === "idle") return "idle";
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase === "stopped" || phase === "stopping" || phase === "draining") return "stopped";
  return "running";
}