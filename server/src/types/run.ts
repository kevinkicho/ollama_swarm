// Auto-extracted from types.ts (DF-4, 2026-05-09)
// Import from "./types.js" for backward compatibility — this file
// is re-exported from types.ts as a barrel.

import type { SwarmEventBody, TranscriptEntry } from "./events.js";
import type { AgentState } from "./agents.js";
import type { RunSummary } from "../swarm/blackboard/summary.js";
import type { ExitContract } from "../swarm/blackboard/types.js";

export type SwarmEvent = SwarmEventBody & { runId?: string };

export type SwarmPhase =
  | "idle"
  | "booting"
  | "cloning"
  | "seeding"
  | "spawning"
  | "planning"
  | "executing"
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
  /** V2 state machine snapshot (Phase 4 partial SoT). */
  runStateV2?: { phase: string; pausedReason?: string };
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
  /**
   * Last agent_activity per agent — control-plane session phase/label for
   * sidebar hydrate after refresh (not WS-only).
   */
  agentActivity?: Record<string, SwarmStatusAgentActivity>;
  // Phase 2a: stigmergy pheromone table keyed by file path. Only
  // populated for stigmergy runs; other presets omit it.
  pheromones?: Record<string, SwarmStatusPheromoneEntry>;
  // Legacy phase fields (may appear in old persisted run summaries/status snapshots).
  // Not emitted or used for new runs (Phase 9/10 full removal of guards + emitters).
  currentPhase?: any;
  phases?: any[];

  // Phase 2d: map-reduce mapper assignments (agentIndex → slice of
  // top-level repo entries). Only populated for map-reduce runs.
  mapperSlices?: Record<string, string[]>;
  /** Per-region status for the run-status dashboard (statechart insight). */
  regions?: RegionStatus;
  /** True when soft drain would preserve in-flight worker work (exec-only). */
  drainEligible?: boolean;
  /** Human reason when drain is not applicable (UI tooltip / Brain context). */
  drainIneligibleReason?: string;
  /** Early-stop detail if the run is winding down for a guard (dead-loop, budget, etc.). */
  earlyStopDetail?: string;
  /** Live Brain OS helpers (ephemeral recruits — agent sidebar). */
  brainOsHelpers?: Array<{
    helperId: string;
    kind: string;
    privilege: string;
    depth: number;
    model?: string;
    startedAt: number;
    phase?: string;
  }>;
  /** Remaining resource budgets when configured (discussion + blackboard). */
  capsRemaining?: {
    wallClockMsRemaining?: number;
    tokenBudgetRemaining?: number;
  };
  /** RR-D: durable-progress heartbeat (ms since epoch / quiet duration). */
  progressHeartbeat?: {
    lastProductiveAt: number;
    progressQuietMs: number;
  };
  /** RR-D: live cycle fail taxonomy (empty cycles, apply/json/tool buckets). */
  cycleIntegrity?: import("@ollama-swarm/shared/cycleIntegrityReport").CycleIntegrityReport;
  /** RR-D: live apply/repair integrity (attempts, misses, repairs). */
  applyIntegrity?: import("@ollama-swarm/shared/applyIntegrityReport").ApplyIntegrityReport;
  /** RR-C: live literature/search blackout + budget integrity. */
  researchIntegrity?: import("../swarm/research/researchBudget.js").ResearchIntegrityReport;
  /** Blackboard planning pipeline step (seeding / contract / todos). */
  planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
  /** Live think-guard referee budget (resolved defaults + usage). */
  thinkGuardReferee?: import("@ollama-swarm/shared/thinkGuardBudget").ResolvedThinkGuardRefereeBudget;
  /**
   * Composite pipeline identity — which sub-preset is running now.
   * Absent for non-pipeline presets.
   */
  pipelinePhase?: {
    /** 1-based index of the active phase. */
    index: number;
    /** Total phases in the configured pipeline. */
    count: number;
    /** Active sub-preset id (e.g. council, blackboard). */
    preset: string;
    /** Full chain for UI (e.g. "council → blackboard"). */
    chain?: string;
  };
}

export interface SwarmStatusStreamingEntry {
  text: string;
  updatedAt: number;
}

export interface SwarmStatusAgentActivity {
  phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
  ts: number;
  startedAt: number;
  activityId?: string;
  kind?: string;
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
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
  topology?: import("../../../shared/src/topology.js").Topology;
  // Unit 43 / 34: per-run caps, mapped to client-friendly strings (min / count)
  // so the SetupForm bar + advanced panels can re-hydrate on refresh / review.
  wallClockCapMin?: string;
  ambitionTiers?: string;
  // User directive — threaded into runners and needed for Resume fidelity.
  userDirective?: string;
  plannerTools?: boolean;
  webTools?: boolean;
  mcpServers?: string;
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
}

/** Lift userDirective / tool flags from persisted run-state extras. */
export function normalizeSwarmStatusRunConfig(
  rc: SwarmStatusRunConfig & { localPath?: string; extras?: Record<string, unknown> },
): SwarmStatusRunConfig {
  const extras = rc.extras ?? {};
  const userDirective =
    (typeof rc.userDirective === "string" && rc.userDirective.trim())
    || (typeof extras.userDirective === "string" && extras.userDirective.trim())
    || undefined;
  const topology =
    rc.topology
    ?? (extras.topology as SwarmStatusRunConfig["topology"] | undefined);
  return {
    ...rc,
    clonePath: rc.clonePath || rc.localPath || "",
    ...(userDirective ? { userDirective } : {}),
    plannerModel:
      rc.plannerModel
      ?? (extras.plannerModel as string | undefined)
      ?? (extras.model as string | undefined),
    workerModel:
      rc.workerModel
      ?? (extras.workerModel as string | undefined)
      ?? (extras.model as string | undefined),
    auditorModel:
      rc.auditorModel
      ?? (extras.auditorModel as string | undefined)
      ?? rc.plannerModel
      ?? (extras.plannerModel as string | undefined)
      ?? (extras.model as string | undefined),
    dedicatedAuditor: rc.dedicatedAuditor ?? (extras.dedicatedAuditor as boolean | undefined) ?? false,
    ...(topology ? { topology } : {}),
    plannerTools: rc.plannerTools ?? (extras.plannerTools as boolean | undefined),
    webTools: rc.webTools ?? (extras.webTools as boolean | undefined),
    mcpServers: rc.mcpServers ?? (extras.mcpServers as string | undefined),
  };
}

export interface SwarmStatusBoard {
  todos: import("../swarm/blackboard/types.js").Todo[];
  findings: import("../swarm/blackboard/types.js").Finding[];
  counts: import("./events.js").BoardCountsDTO;
}

export interface SwarmStatusLatencySample {
  ts: number;
  elapsedMs: number;
  success: boolean;
  attempt: number;
}
