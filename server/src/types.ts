import type {
  BoardSnapshot,
  Claim,
  ExitContract,
  Finding,
  Todo,
} from "./swarm/blackboard/types.js";
import type { RunSummary } from "./swarm/blackboard/summary.js";

export type AgentStatus =
  | "spawning"
  | "ready"
  | "thinking"
  | "retrying"
  | "failed"
  | "stopped";

export interface AgentState {
  id: string;
  index: number;
  port: number;
  sessionId?: string;
  status: AgentStatus;
  lastMessageAt?: number;
  error?: string;
  // Unit 7: set only while status === "retrying" so the UI can render
  // "Agent N · retrying 2/3 · UND_ERR_HEADERS_TIMEOUT" instead of an
  // opaque "thinking" during the 5-15 min backoff window.
  retryAttempt?: number;
  retryMax?: number;
  retryReason?: string;
  // Unit 39: timestamp (ms since epoch) of when this agent flipped INTO
  // the current "thinking" state. The UI renders elapsed time ("thinking
  // 3m54s") by subtracting this from Date.now() in a 1 s interval while
  // status === "thinking". Unset for non-thinking states. This is the
  // honest user-facing display during the HEADERS_TIMEOUT window —
  // distinguishes "patiently waiting for a real response" from
  // "something broke" (which is only true after a retry actually fires).
  thinkingSince?: number;
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
  | { type: "board_state"; snapshot: BoardSnapshot; counts: BoardCountsDTO }
  | { type: "contract_updated"; contract: ExitContract }
  | { type: "run_summary"; summary: RunSummary }
  // Unit 40: per-attempt latency sample emitted by each runner's
  // onTiming callback (sibling of the existing logDiag /
  // _prompt_timing record but delivered over the WS stream so the UI
  // can accumulate recent samples and render a sparkline tooltip).
  // `elapsedMs` is wall-clock from the start of session.prompt to
  // either (a) its resolution if success, or (b) the headers-timeout
  // bail if not.
  | {
      type: "agent_latency_sample";
      agentId: string;
      agentIndex: number;
      attempt: number;
      elapsedMs: number;
      success: boolean;
      ts: number;
    }
  // Unit 47: emitted once per run, right after RepoService.clone
  // resolves. `alreadyPresent` distinguishes a fresh shallow clone
  // from a build-on-existing-clone resume. The 3 counts give the UI
  // enough to render a "you're resuming N prior commits + M modified
  // + K untracked" banner without a separate fetch. Clone path is
  // included so a UI banner can show what the resume targets.
  | {
      type: "clone_state";
      alreadyPresent: boolean;
      clonePath: string;
      priorCommits: number;
      priorChangedFiles: number;
      priorUntrackedFiles: number;
    }
  // Unit 52a + 52c: emitted once at the very top of Orchestrator.start
  // so the UI's runtime ticker has a stable wall-clock anchor AND the
  // run-identity strip has its config data without a separate REST
  // round-trip. Fires BEFORE the runner's first phase transition, so
  // a slow clone + spawn count toward the user-visible runtime. The
  // summary's startedAt may differ slightly (it tracks "executing"
  // start for cap math), but the user-visible ticker uses THIS value.
  | {
      type: "run_started";
      startedAt: number;
      preset: string;
      plannerModel: string;
      workerModel: string;
      repoUrl: string;
      clonePath: string;
      agentCount: number;
      rounds: number;
    };

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
  parentPath: string;
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
  // Stashed on runs that have finished writing their summary so a page
  // reload can replay the card via the WS catch-up handler in index.ts.
  // Stays undefined until the run actually completes/stops/crashes.
  summary?: RunSummary;
  contract?: ExitContract;
}
