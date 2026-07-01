// Shim — re-exports from consolidated resilience module.
// Original implementation moved to server/src/swarm/resilience/failoverChain.ts

export { promptWithFailover } from "./resilience/failoverChain.js";
export type { FailoverState, FailoverConfig, PromptFn } from "./resilience/types.js";