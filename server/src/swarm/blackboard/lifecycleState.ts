/**
 * LifecycleState helpers — delegates state management to the BlackboardRunner.
 * The lifecycle state mirrors SwarmPhase for the subset of phases the
 * lifecycle runner manages directly: idle → running → draining → stopping → stopped.
 */

import type { LifecycleState } from "../../types.js";

export type { LifecycleState };

export const LIFECYCLE_STATES: ReadonlySet<LifecycleState> = new Set([
  "idle",
  "running",
  "draining",
  "stopping",
  "stopped",
]);

export function isStopping(state: LifecycleState): boolean {
  return state === "stopping";
}

export function isDraining(state: LifecycleState): boolean {
  return state === "draining";
}

export function isActive(state: LifecycleState): boolean {
  return state === "running" || state === "draining";
}

export function isTerminal(state: LifecycleState): boolean {
  return state === "stopped" || state === "idle";
}