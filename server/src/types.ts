import type {
  BoardSnapshot,
  Claim,
  Finding,
  Todo,
} from "./swarm/blackboard/types.js";

export type AgentStatus = "spawning" | "ready" | "thinking" | "failed" | "stopped";

export interface AgentState {
  id: string;
  index: number;
  port: number;
  sessionId?: string;
  status: AgentStatus;
  lastMessageAt?: number;
  error?: string;
}

export type TranscriptRole = "system" | "user" | "agent";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  agentId?: string;
  agentIndex?: number;
  text: string;
  ts: number;
}

export interface BoardCountsDTO {
  open: number;
  claimed: number;
  committed: number;
  stale: number;
  skipped: number;
  total: number;
}

export type SwarmEvent =
  | { type: "transcript_append"; entry: TranscriptEntry }
  | { type: "agent_state"; agent: AgentState }
  | { type: "swarm_state"; phase: SwarmPhase; round: number }
  | { type: "agent_streaming"; agentId: string; agentIndex: number; text: string }
  | { type: "agent_streaming_end"; agentId: string }
  | { type: "error"; message: string }
  | { type: "board_todo_posted"; todo: Todo }
  | { type: "board_todo_claimed"; todoId: string; claim: Claim }
  | { type: "board_todo_committed"; todoId: string }
  | { type: "board_todo_stale"; todoId: string; reason: string; replanCount: number }
  | { type: "board_todo_skipped"; todoId: string; reason: string }
  | {
      type: "board_todo_replanned";
      todoId: string;
      description: string;
      expectedFiles: string[];
      replanCount: number;
    }
  | { type: "board_finding_posted"; finding: Finding }
  | { type: "board_state"; snapshot: BoardSnapshot; counts: BoardCountsDTO };

export type SwarmPhase =
  | "idle"
  | "cloning"
  | "spawning"
  | "seeding"
  | "discussing"
  | "planning"
  | "executing"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export interface StartSwarmRequest {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  model?: string;
  rounds?: number;
  preset?: "round-robin" | "blackboard";
}

export interface SwarmStatus {
  phase: SwarmPhase;
  round: number;
  repoUrl?: string;
  localPath?: string;
  model?: string;
  agents: AgentState[];
  transcript: TranscriptEntry[];
}
