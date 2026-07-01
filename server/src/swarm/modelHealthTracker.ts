// Shim — re-exports from consolidated resilience module.
// Original implementation moved to server/src/swarm/resilience/healthTracker.ts

export { evaluateModelHealth, trimAttemptWindow } from "./resilience/healthTracker.js";
export type { AttemptRecord, ModelHealthInput, ModelHealthVerdict } from "./resilience/types.js";