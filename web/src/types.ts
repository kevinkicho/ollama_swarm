// V2 Step 2b: TranscriptEntrySummary moved to shared/. Imported here
// so the TranscriptEntry interface can reference it; re-exported so
// existing web-side imports (`from "../types"`) keep working.
import type { TranscriptEntrySummary } from "../../shared/src/transcriptEntrySummary";
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
  // Unit 7: populated while status === "retrying" so the panel can render
  // "retrying 2/3 · UND_ERR_HEADERS_TIMEOUT" during the backoff window.
  retryAttempt?: number;
  retryMax?: number;
  retryReason?: string;
  // Unit 39: timestamp when status flipped to "thinking". Panel uses
  // it to render a ticking "thinking 3m54s" so a legitimate slow
  // prompt doesn't look like an error. Unset for non-thinking states.
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
  // Unit 54: server-computed structured summary of the agent's
  // response when it parsed as a known envelope. Web prefers this
  // over its own client-side summarizer because the server has the
  // authoritative parser. Absent on system/user entries and on
  // agent entries that didn't parse server-side.
  summary?: TranscriptEntrySummary;
  // 2026-04-26: client-only field. When the streaming bubble
  // computed segment split points (5s+ pause boundaries), they get
  // copied here on transcript_append finalization so the post-stream
  // bubble can render with the same segment structure the user saw
  // live. Indices into `text`. Never set by server (typed optional).
  segmentSplitPoints?: number[];
}

export type SwarmPhase =
  | "idle"
  | "cloning"
  | "spawning"
  | "seeding"
  | "discussing"
  | "planning"
  | "executing"
  // Task #165: blackboard pauses on persistent Ollama-quota wall and
  // probes every 5 min until upstream clears. 2h max before halting.
  | "paused"
  // Task #167: soft-stop. Workers finish current claim, then exit.
  | "draining"
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
  // Unit 44b: planner-declared anchor strings. Server uses these to
  // inject ±25 lines of context around each match into the worker
  // prompt, so workers can edit middle-region rows of large files.
  // The UI doesn't render them today; mirrored here so the type stays
  // honest with what crosses the WS.
  expectedAnchors?: string[];
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
  | "cap:todos"
  | "cap:tokens"
  | "cap:quota"
  | "early-stop"
  | "no-progress";

export interface PerAgentStat {
  agentId: string;
  agentIndex: number;
  turnsTaken: number;
  tokensIn: number | null;
  tokensOut: number | null;
  // Unit 21: per-agent attempt + latency stats. Optional because
  // older summaries or runs that crashed before any prompt fired
  // won't have them. See server-side PerAgentStat for semantics:
  // totalAttempts includes retries; totalRetries is the retry-fire
  // count; latency is over SUCCESSFUL attempts only.
  totalAttempts?: number;
  totalRetries?: number;
  successfulAttempts?: number;
  meanLatencyMs?: number | null;
  p50LatencyMs?: number | null;
  p95LatencyMs?: number | null;
  // Task #66 (2026-04-24): per-agent commit + line counts. Blackboard-only;
  // discussion presets stay 0/undefined since they don't write code.
  // Modal renders these as columns; "—" when undefined.
  commits?: number;
  linesAdded?: number;
  linesRemoved?: number;
  // Task #67 (2026-04-24): per-agent rejected-work + recovery counters.
  // Blackboard-only; — for discussion presets in the modal.
  rejectedAttempts?: number;
  jsonRepairs?: number;
  promptErrors?: number;
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
  contract?: ExitContract;
  // Task #65 (2026-04-24): persisted transcript snapshot at run-end.
  // Optional — older summaries don't have it. Capped server-side at
  // TRANSCRIPT_MAX_ENTRIES; transcriptTruncated=true when capped.
  transcript?: TranscriptEntry[];
  transcriptTruncated?: boolean;
  // V2 Step 3b.2: end-of-run snapshot of the parallel V2 reducer state
  // and accumulated divergences. Blackboard-only. Optional — older
  // summaries don't have it. Zero divergences = V1↔V2 agreement.
  v2State?: {
    phase: string;
    enteredAt: number;
    detail?: string;
    pausedReason?: string;
    divergenceCount: number;
    divergences: Array<{
      v1Phase: string;
      v2Phase: string;
      expectedV2Phases: string;
      ts: number;
      trigger: string;
    }>;
  };
  // V2 Step 5c.1: parallel-track V2 TodoQueue mirror. Blackboard-only.
  // Counts at run end + per-event divergences vs V1 board.counts().
  // Zero divergences = the V2 queue tracked V1 perfectly across the run.
  v2QueueState?: {
    counts: {
      pending: number;
      inProgress: number;
      completed: number;
      failed: number;
      skipped: number;
      total: number;
    };
    divergenceCount: number;
    divergences: Array<{
      ts: number;
      trigger: string;
      v1: { open: number; claimed: number; committed: number; stale: number; skipped: number };
      v2: { pending: number; inProgress: number; completed: number; failed: number; skipped: number };
    }>;
  };
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
      // Unit 44b: optional anchor revision. Server emits it when the
      // replanner explicitly revised anchors; absent means "keep prior."
      expectedAnchors?: string[];
    }
  | { type: "board_finding_posted"; finding: Finding }
  | { type: "board_state"; snapshot: BoardSnapshot; counts: BoardCountsDTO }
  | { type: "contract_updated"; contract: ExitContract }
  | { type: "run_summary"; summary: RunSummary }
  // Phase 2a: stigmergy pheromone update.
  | {
      type: "pheromone_updated";
      file: string;
      state: PheromoneEntry;
    }
  // Phase 2d: map-reduce mapper slice assignments.
  | {
      type: "mapper_slices";
      slices: Record<string, string[]>;
    }
  // Unit 40: per-attempt latency sample. The zustand store keeps a
  // bounded rolling window per agent; the AgentPanel renders it as a
  // sparkline in the "thinking 3m54s" tooltip so users can see whether
  // the CURRENT wait is typical for this agent or much longer than
  // recent attempts.
  | {
      type: "agent_latency_sample";
      agentId: string;
      agentIndex: number;
      attempt: number;
      elapsedMs: number;
      success: boolean;
      ts: number;
    }
  // Unit 47: emitted once per run, right after the clone completes.
  // alreadyPresent=true means the runner reused an existing clone
  // (build-on-existing-clone work pattern) — UI surfaces a banner so
  // the user knows the run is building on prior progress, not a
  // fresh start.
  | {
      type: "clone_state";
      alreadyPresent: boolean;
      clonePath: string;
      priorCommits: number;
      priorChangedFiles: number;
      priorUntrackedFiles: number;
    }
  // Unit 52a + 52c + 52d: emitted once at the very top of Orchestrator.start.
  // Anchors the runtime ticker + identity strip + identifiers row.
  // `runId` (Unit 52d) is an app-level uuid minted at run-start,
  // distinct from any opencode session id.
  | {
      type: "run_started";
      runId: string;
      startedAt: number;
      preset: string;
      plannerModel: string;
      workerModel: string;
      // Auditor-related fields drive AgentPanel role + model display
      // for the dedicated auditor at index N+1 (Unit 58).
      auditorModel: string;
      dedicatedAuditor: boolean;
      // Task #42: role-diff role names indexed by (agentIndex - 1).
      roles?: string[];
      repoUrl: string;
      clonePath: string;
      agentCount: number;
      rounds: number;
    };

// Shared shape returned by GET /api/swarm/preflight. Drives both the
// inline PreflightPreview under the Parent folder field AND the
// pre-Start confirmation modal (StartConfirmModal) that gates Start
// when an existing clone is detected.
export interface PreflightState {
  destPath: string;
  exists: boolean;
  isGitRepo: boolean;
  alreadyPresent: boolean;
  priorCommits: number;
  priorChangedFiles: number;
  priorUntrackedFiles: number;
  blocker?: "not-git-repo";
}

// Phase 2a (2026-04-24): stigmergy pheromone table entry — the shared
// annotation state that drives file-picking. Mirror of
// SwarmStatusPheromoneEntry server-side.
export interface PheromoneEntry {
  visits: number;
  avgInterest: number;
  avgConfidence: number;
  latestNote: string;
}

// Unit 40: one recent-latency sample as stored client-side.
export interface LatencySample {
  ts: number;
  elapsedMs: number;
  success: boolean;
  attempt: number;
}

// Unit 47: client-side mirror of the clone_state event payload.
export interface CloneState {
  alreadyPresent: boolean;
  clonePath: string;
  priorCommits: number;
  priorChangedFiles: number;
  priorUntrackedFiles: number;
}

// Unit 52c: client-side mirror of the run_started event's config
// fields. Used by the run-identity strip in SwarmView. Excludes
// startedAt (kept as a separate ticker anchor in store.runStartedAt).
export interface RunConfigSnapshot {
  preset: string;
  plannerModel: string;
  workerModel: string;
  // Auditor model (used at index N+1 when dedicatedAuditor=true).
  // Always set in run_started — falls back to plannerModel when the
  // user didn't override.
  auditorModel: string;
  dedicatedAuditor: boolean;
  // Task #42: role-diff role names indexed by (agentIndex - 1).
  roles?: string[];
  repoUrl: string;
  clonePath: string;
  agentCount: number;
  rounds: number;
}

// Unit 52e: digest returned by GET /api/runs for the run-history
// dropdown. Mirror of server-side RunSummaryDigest in
// server/src/routes/swarm.ts. Optional fields are blackboard-only
// (commits / totalTodos / hasContract) and absent on discussion-
// preset summaries.
export interface RunSummaryDigest {
  name: string;
  clonePath: string;
  preset: string;
  model: string;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  stopReason?: string;
  commits?: number;
  totalTodos?: number;
  hasContract: boolean;
  isActive: boolean;
  // Task #36: app-level runId (uuid) from the summary.json. Absent on
  // pre-task-36 runs so the dropdown renders "—" for legacy rows.
  runId?: string;
}

// Unit 62: shape returned by GET /api/swarm/status. Mirror of the
// server-side SwarmStatus interface — used by useSwarmSocket on
// mount to hydrate the zustand store after a page refresh. All
// catch-up fields are optional (discussion presets, idle phase,
// pre-run state).
export interface SwarmStatusSnapshot {
  phase: SwarmPhase;
  round: number;
  agents: AgentState[];
  transcript: TranscriptEntry[];
  summary?: RunSummary;
  contract?: ExitContract;
  cloneState?: CloneState;
  runConfig?: RunConfigSnapshot;
  runId?: string;
  runStartedAt?: number;
  board?: {
    todos: Todo[];
    findings: Finding[];
    counts: BoardCountsDTO;
  };
  latency?: Record<string, LatencySample[]>;
  // Task #39: per-agent partial-stream text captured server-side so
  // a Ctrl-R mid-stream can restore the in-progress agent turn.
  streaming?: Record<string, { text: string; updatedAt: number }>;
  // Phase 2a: stigmergy pheromone table for catch-up hydration.
  pheromones?: Record<string, PheromoneEntry>;
  // Phase 2d: map-reduce mapper slice assignments for catch-up.
  mapperSlices?: Record<string, string[]>;
}
