// Shim — re-exports from consolidated resilience module.
// Original implementation moved to server/src/swarm/resilience/failoverChain.ts

export { decideFailover, pickLocalFallback, isCloudModel } from "./resilience/failoverChain.js";
export type { FailoverAction, FailoverDecision, FailoverInput } from "./resilience/types.js";