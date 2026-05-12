// Barrel file — re-exports from domain files.
// Import from here for backward compatibility. All types are organized in:
//   types/events.ts — SwarmEventBody, TranscriptEntry, BoardCountsDTO
//   types/agents.ts — AgentState, AgentStatus
//   types/run.ts    — SwarmPhase, SwarmStatus, RegionStatus, LifecycleState

import type {
  BoardSnapshot,
  Claim,
  ExitContract,
  Finding,
  Todo,
} from "./swarm/blackboard/types.js";
import type { RunSummary } from "./swarm/blackboard/summary.js";
// V2 Step 2b: TranscriptEntrySummary moved to shared/. Imported here
// so the TranscriptEntry interface can reference it; re-exported so
// existing server-side imports (`from "../types.js"`) keep working.
import type { TranscriptEntrySummary } from "../../shared/src/transcriptEntrySummary.js";
export type { TranscriptEntrySummary };


// ── Events ──
export type { TranscriptEntrySummary } from "./types/events.js";
export type { TranscriptRole, TranscriptEntry, BoardCountsDTO, SwarmEventBody, SwarmEvent } from "./types/events.js";

// ── Agents ──
export type { AgentStatus, AgentState } from "./types/agents.js";

// ── Run state ──
export type { SwarmPhase, LifecycleState, RegionStatus, SwarmStatus, SwarmStatusStreamingEntry, SwarmStatusPheromoneEntry, SwarmStatusCloneState, SwarmStatusRunConfig, SwarmStatusBoard, SwarmStatusLatencySample } from "./types/run.js";
