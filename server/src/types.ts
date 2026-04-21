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

export type SwarmEvent =
  | { type: "transcript_append"; entry: TranscriptEntry }
  | { type: "agent_state"; agent: AgentState }
  | { type: "swarm_state"; phase: SwarmPhase; round: number }
  | { type: "agent_streaming"; agentId: string; agentIndex: number; text: string }
  | { type: "agent_streaming_end"; agentId: string }
  | { type: "error"; message: string };

export type SwarmPhase =
  | "idle"
  | "cloning"
  | "spawning"
  | "seeding"
  | "discussing"
  | "stopping"
  | "stopped"
  | "completed";

export interface StartSwarmRequest {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  model?: string;
  rounds?: number;
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
