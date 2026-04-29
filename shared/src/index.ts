// V2 Step 2: shared types + parsers used by both server (envelope
// validation, prompt response parsing) and web (transcript bubble
// rendering, structured summary derivation). Single source of truth.

export {
  extractJsonFromText,
  extractFirstBalanced,
  extractFirstBalancedJson,
} from "./extractJson.js";

export type { TranscriptEntrySummary } from "./transcriptEntrySummary.js";

export { summarizeAgentJson } from "./summarizeAgentJson.js";
export type { AgentJsonSummary } from "./summarizeAgentJson.js";

export { formatServerSummary } from "./formatServerSummary.js";

export {
  INITIAL_STATE,
  reduce,
  isTerminal,
  plannerShouldFire,
  workersShouldClaim,
  runFinished,
} from "./runStateMachine.js";
export type {
  RunPhase,
  RunState,
  RunEvent,
  RunContext,
} from "./runStateMachine.js";

export {
  AGENT_ROLES,
  AGENT_COLORS,
  AgentSpecSchema,
  TopologySchema,
  defaultRoleForIndex,
  isRoleStructural,
  synthesizeTopology,
  deriveLegacyFields,
  findAgentSpec,
  getAgentAddendum,
  getAgentTag,
  getAgentOllamaOptions,
} from "./topology.js";
export type { AgentRole, AgentColor, AgentSpec, Topology } from "./topology.js";

export {
  PROVIDERS,
  detectProvider,
  stripProviderPrefix,
  withProviderPrefix,
  toOpenCodeModelRef,
  modelsForProvider,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
} from "./providers.js";
export type { Provider, OpenCodeModelRef } from "./providers.js";
