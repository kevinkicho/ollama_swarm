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
