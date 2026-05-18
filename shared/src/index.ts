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
  getAgentAddendum,
  getAgentOllamaOptions,
} from "./topology.js";
export type { AgentRole, AgentColor, AgentSpec, Topology } from "./topology.js";

export {
  PROVIDERS,
  detectProvider,
  stripProviderPrefix,
  toOpenCodeModelRef,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
} from "./providers.js";
export type { Provider, OpenCodeModelRef } from "./providers.js";

// WS wire-protocol schemas + types (single source of truth for both
// server broadcast and web client validation).
export {
  SwarmPhaseSchema,
  TodoStatusSchema,
  ExitCriterionStatusSchema,
  StopReasonSchema,
  AgentStatusSchema,
  TranscriptRoleSchema,
  ClaimSchema,
  ExitCriterionSchema,
  ExitContractSchema,
  TodoSchema,
  AgentStateSchema,
  FindingSchema,
  BoardSnapshotSchema,
  BoardCountsDTOSchema,
  DeliverableSchema,
  SwarmEventSchema,
  PerAgentStatSchema,
  validateSwarmEvent,
} from "./wsProtocol.js";
export type {
  SwarmPhase,
  TodoStatus,
  ExitCriterionStatus,
  StopReason,
  AgentStatus,
  TranscriptRole,
  Claim,
  ExitCriterion,
  ExitContract,
  Todo,
  AgentState as WsAgentState,
  Finding,
  BoardSnapshot as WsBoardSnapshot,
  BoardCountsDTO as WsBoardCountsDTO,
  Deliverable,
  SwarmEvent,
  PerAgentStat,
} from "./wsProtocol.js";
