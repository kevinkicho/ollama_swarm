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

export type TodoStatus = "open" | "claimed" | "committed" | "stale" | "skipped";

export interface Claim {
  todoId: string;
  agentId: string;
  fileHashes: Record<string, string>;
  claimedAt: number;
  expiresAt: number;
}

export interface Todo {
  id: string;
  description: string;
  expectedFiles: string[];
  createdBy: string;
  createdAt: number;
  status: TodoStatus;
  staleReason?: string;
  skippedReason?: string;
  replanCount: number;
  claim?: Claim;
  committedAt?: number;
  criterionId?: string;
}

export type ExitCriterionStatus = "unmet" | "met" | "wont-do";

export interface ExitCriterion {
  id: string;
  description: string;
  expectedFiles: string[];
  status: ExitCriterionStatus;
  rationale?: string;
  addedAt: number;
}

export interface ExitContract {
  missionStatement: string;
  criteria: ExitCriterion[];
}

export interface Finding {
  id: string;
  agentId: string;
  text: string;
  createdAt: number;
}

export interface BoardSnapshot {
  todos: Todo[];
  findings: Finding[];
}

export type StopReason =
  | "completed"
  | "user"
  | "crash"
  | "cap:wall-clock"
  | "cap:commits"
  | "cap:todos";

export interface PerAgentStat {
  agentId: string;
  agentIndex: number;
  turnsTaken: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface RunSummary {
  repoUrl: string;
  localPath: string;
  preset: string;
  model: string;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  stopReason: StopReason;
  stopDetail?: string;
  commits: number;
  staleEvents: number;
  skippedTodos: number;
  totalTodos: number;
  filesChanged: number;
  finalGitStatus: string;
  finalGitStatusTruncated: boolean;
  agents: PerAgentStat[];
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
  | { type: "board_state"; snapshot: BoardSnapshot; counts: BoardCountsDTO }
  | { type: "contract_updated"; contract: ExitContract }
  | { type: "run_summary"; summary: RunSummary };
