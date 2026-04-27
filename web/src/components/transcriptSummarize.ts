// V2 Step 2c: re-export from shared/. Single source of truth in
// shared/src/summarizeAgentJson.ts (consumed by both server and web).
// Existing web-side imports keep working without changes.

export { summarizeAgentJson } from "../../../shared/src/summarizeAgentJson";
export type { AgentJsonSummary } from "../../../shared/src/summarizeAgentJson";
