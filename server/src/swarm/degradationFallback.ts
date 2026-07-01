// Shim — re-exports from consolidated resilience module.
// Original implementation moved to server/src/swarm/resilience/failoverChain.ts

export { pickLocalFallback, isCloudModel, inferParamSize } from "./resilience/failoverChain.js";