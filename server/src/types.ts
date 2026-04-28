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
  // Unit 54: optional structured summary for agent responses that
  // parse as a known JSON envelope (worker hunks/skip, planner todo
  // list, auditor verdict, etc.). The UI uses this to render a
  // one-line summary by default and only show the raw text on
  // click-to-expand. Absent on system/user entries and on agent
  // entries that don't parse as a recognized envelope.
  summary?: TranscriptEntrySummary;
  // 2026-04-27 (UI Phase 1): when an agent emitted <think>...</think>
  // markers (reasoning models), the server-side appendAgent strips
  // them out into this field via shared/extractThinkTags. The text
  // field carries the FINAL response only. UI renders thoughts as a
  // collapsed-by-default ThoughtsBlock above the main bubble. Absent
  // on system/user entries and on agent entries with no <think> tags.
  thoughts?: string;
  // 2026-04-27 evening (#229): when an agent emitted XML pseudo-tool-
  // call markers (<read>, <grep>, <list>, <glob>, <edit>, <bash>) as
  // raw text, server-side appendAgent strips them via shared/
  // extractToolCallMarkers. UI renders as a collapsed-by-default
  // ToolCallsBlock above the main bubble. Each entry is the raw
  // marker text (e.g., `<read path='src/foo.ts' />`).
  toolCalls?: string[];
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
  // Phase 2a (2026-04-24): stigmergy pheromone update fired per
  // annotation commit. Carries the single file's new state so the
  // client can upsert without receiving the full table each time.
  | {
      type: "pheromone_updated";
      file: string;
      state: { visits: number; avgInterest: number; avgConfidence: number; latestNote: string };
    }
  // Phase 2d (2026-04-24): map-reduce mapper slice assignments. Fired
  // once at the top of the run, after slicing. Keyed by agentIndex;
  // agent-1 (reducer) is excluded (it sees everything via transcript).
  | {
      type: "mapper_slices";
      slices: Record<string, string[]>;
    }
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
  // Unit 52a + 52c + 52d: emitted once at the very top of Orchestrator.start.
  // runId (Unit 52d) is a fresh uuid the orchestrator mints at run-start
  // so the UI identifiers row has an app-level handle distinct from any
  // opencode session id. Other fields anchor the runtime ticker and
  // identity strip without a separate REST round-trip.
  | {
      type: "run_started";
      runId: string;
      startedAt: number;
      preset: string;
      plannerModel: string;
      workerModel: string;
      // Auditor model used when cfg.dedicatedAuditor is true. Emitted
      // unconditionally (falls back to plannerModel → main model when
      // the user didn't override) so the UI can label the agent at
      // index N+1 with its actual model. Discussion presets ignore.
      auditorModel: string;
      // Whether the run spawned a dedicated auditor at index N+1.
      // The UI uses this to label that agent's role correctly.
      dedicatedAuditor: boolean;
      // Task #42: role-diff only — array of role names indexed by
      // (agentIndex - 1). Empty/undefined on other presets. Drives
      // AgentPanel's role label for role-diff (e.g. "Architect"
      // instead of the generic "worker"). Wraps on (index % roles.length)
      // like roleForAgent() to match the runner's resolution.
      roles?: string[];
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
  // Task #165: blackboard pauses on persistent Ollama-quota wall and
  // probes every 5 min until upstream clears. Wall-clock cap doesn't
  // burn while paused; total pause capped at 2h before escalating to
  // permanent cap:quota halt.
  | "paused"
  // Task #167: soft-stop. User pressed "Drain & Stop" — workers finish
  // their current claim (so no in-flight commits get lost), no new
  // claims permitted, then escalate to hard stop. Backstopped at 3 min;
  // user can press hard "Stop" to escalate immediately.
  | "draining"
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
  // Unit 62: page-refresh catch-up state. Populated by
  // BlackboardRunner.status() so the web can hydrate its zustand
  // store from one HTTP fetch instead of waiting for the next batch
  // of WS events to redraw the screen. All fields optional —
  // discussion presets leave the blackboard-specific ones absent,
  // and pre-Unit-X clients silently ignore them.
  cloneState?: SwarmStatusCloneState;
  runConfig?: SwarmStatusRunConfig;
  runId?: string;
  runStartedAt?: number;
  board?: SwarmStatusBoard;
  // Per-agent recent-latency samples (bounded — same window the
  // client renders in the sparkline tooltip). Empty / absent on
  // discussion presets.
  latency?: Record<string, SwarmStatusLatencySample[]>;
  // Task #39: per-agent partial-stream text captured in memory so a
  // page-refresh catch-up can restore the mid-stream UI state. Keyed
  // by agentId; present only for agents whose stream hasn't yet hit
  // session.idle. Empty / absent when no stream is active.
  streaming?: Record<string, SwarmStatusStreamingEntry>;
  // Phase 2a: stigmergy pheromone table keyed by file path. Only
  // populated for stigmergy runs; other presets omit it.
  pheromones?: Record<string, SwarmStatusPheromoneEntry>;
  // Phase 2d: map-reduce mapper assignments (agentIndex → slice of
  // top-level repo entries). Only populated for map-reduce runs.
  mapperSlices?: Record<string, string[]>;
}

export interface SwarmStatusStreamingEntry {
  text: string;
  updatedAt: number;
}

// Phase 2a (2026-04-24): stigmergy-only pheromone table. File path →
// annotation state. Drives every agent's next-file pick during a
// stigmergy run; previously this was the ONE piece of state the UI
// couldn't see at all.
export interface SwarmStatusPheromoneEntry {
  visits: number;
  avgInterest: number;
  avgConfidence: number;
  latestNote: string;
}

// Unit 62: shapes for the SwarmStatus catch-up payload. Mirror of
// the same fields the WS broadcasts in clone_state / run_started /
// board_state / agent_latency_sample events — keeping them
// duplicated in a snapshot type is the simplest way to let the web
// hydrate from one HTTP call without juggling event-shaped data.
export interface SwarmStatusCloneState {
  alreadyPresent: boolean;
  clonePath: string;
  priorCommits: number;
  priorChangedFiles: number;
  priorUntrackedFiles: number;
}

export interface SwarmStatusRunConfig {
  preset: string;
  plannerModel: string;
  workerModel: string;
  // Mirrors run_started — auditor model + dedicatedAuditor flag for
  // the AgentPanel role/model display at index N+1.
  auditorModel: string;
  dedicatedAuditor: boolean;
  // Task #42: role-diff role names indexed by (agentIndex - 1).
  roles?: string[];
  repoUrl: string;
  clonePath: string;
  agentCount: number;
  rounds: number;
  // Phase 4b of #243: topology snapshot. When present, AgentPanel and
  // SwarmView prefer it over re-deriving role+model from preset+index
  // (the `agentRole`/`agentModel` helpers in SwarmView were the third
  // copy of that logic). Optional during the rollout — older clients
  // and tests still work via the legacy fields.
  topology?: import("../../shared/src/topology.js").Topology;
}

export interface SwarmStatusBoard {
  todos: import("./swarm/blackboard/types.js").Todo[];
  findings: import("./swarm/blackboard/types.js").Finding[];
  counts: BoardCountsDTO;
}

export interface SwarmStatusLatencySample {
  ts: number;
  elapsedMs: number;
  success: boolean;
  attempt: number;
}
