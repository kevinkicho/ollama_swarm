// Auto-extracted from types.ts (DF-4, 2026-05-09)
// Import from "./types.js" for backward compatibility — this file
// is re-exported from types.ts as a barrel.

export type SwarmEvent = SwarmEventBody & { runId?: string };

export type SwarmPhase =
  | "idle"
  | "booting"
  | "cloning"
  | "seeding"
  | "discussing"
  | "auditing"
  | "paused"
  | "draining"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

/** Internal lifecycle state machine — mirrors SwarmPhase for the subset
 *  of phases the lifecycle runner manages directly. Used by
 *  lifecycleState.ts to track the primary run lifecycle. */
export type LifecycleState = "idle" | "running" | "draining" | "stopping" | "stopped";

/** Independent run regions — worker state, queue counts, cap status
 *  can all change independently while the lifecycle phase stays "running." */
export interface RegionStatus {
  lifecycle: "idle" | "booting" | "active" | "draining" | "stopped";
  planner: "idle" | "thinking" | "waiting";
  workers: { total: number; thinking: number; idle: number };
  queue: { open: number; claimed: number; committed: number; stale: number };
  caps: { paused: boolean; reason?: "quota" | "memory" | "subscriber" | "wall-clock" };
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
  /** Per-region status for the run-status dashboard (statechart insight). */
  regions?: RegionStatus;

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
// queue_state / agent_latency_sample events — keeping them
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
