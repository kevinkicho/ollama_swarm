// V2 Step 2b: TranscriptEntrySummary moved to shared/. Imported here
// so the TranscriptEntry interface can reference it; re-exported so
// existing web-side imports (`from "../types"`) keep working.
import type { TranscriptEntrySummary } from "@ollama-swarm/shared/transcriptEntrySummary";
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
  sessionId?: string;
  status: AgentStatus;
  lastMessageAt?: number;
  error?: string;
  // Current model this agent is using (reflects failover). Post-E3 Phase 5
  // removed per-agent opencode subprocesses; this is the meaningful
  // per-agent identifier (port was always 0 and has been removed).
  model?: string;
  // Unit 7: populated while status === "retrying" so the panel can render
  // "retrying 2/3 · UND_ERR_HEADERS_TIMEOUT" during the backoff window.
  retryAttempt?: number;
  retryMax?: number;
  retryReason?: string;
  // Unit 39: timestamp when status flipped to "thinking". Panel uses
  // it to render a ticking "thinking 3m54s" so a legitimate slow
  // prompt doesn't look like an error. Unset for non-thinking states.
  thinkingSince?: number;
  activityKind?: string;
  activityLabel?: string;
  activityAttempt?: number;
  activityMaxAttempts?: number;
}

export type TranscriptRole = "system" | "user" | "agent" | "agent-stream";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  agentId?: string;
  agentIndex?: number;
  text: string;
  ts: number;
  /** Chat lever #2: suggest | steer | ask from /api/swarm/say */
  intent?: "suggest" | "steer" | "ask";
  /** @mention routing — only this agent's prompts see the message when set */
  targetAgent?: string;

  // Unit 54: server-computed structured summary of the agent's
  // response when it parsed as a known envelope. Web prefers this
  // over its own client-side summarizer because the server has the
  // authoritative parser. Absent on system/user entries and on
  // agent entries that didn't parse server-side.
  summary?: TranscriptEntrySummary;
  // 2026-04-27 (UI Phase 1): when an agent emitted  thinking... response
  // markers (reasoning models), the server-side appendAgent strips
  // them out into this field via shared/extractThinkTags. The text
  // field carries the FINAL response only. UI renders thoughts inside
  // the agent bubble via a "Thinking" toggle (see AgentThinking.tsx).
  thoughts?: string;
  // 2026-04-27 evening (#229): when an agent emitted XML pseudo-tool-
  // call markers (<read>, <grep>, <list>, <glob>, <edit>, <bash>) as
  // raw text, server-side appendAgent strips them via shared/
  // extractToolCallMarkers. UI renders as a collapsed-by-default
  // ToolCallsBlock above the main bubble.
  toolCalls?: string[];
  // 2026-06-30 (Plan 1): metadata for agent-stream entries — preserves
  // the streaming text that was visible while the agent was thinking.
  // Only present on role="agent-stream" entries.
  streamingMeta?: {
    startedAt: number;
    lastTextAt: number;
    toolCallCount: number;
    totalSeconds: number;
  };
  // Client-side fold of a superseded agent-stream snapshot into the final
  // agent bubble (toggle via CouncilDraftBubble / AgentJsonBubble).
  streamSnapshot?: {
    text: string;
    streamingMeta?: TranscriptEntry["streamingMeta"];
  };
  /** Blackboard auditor assist — JSON salvage bubble labeling. */
  assistKind?: "auditor-salvage" | "auditor-diagnostic";
  /** Outbound prompt sent to this agent for the turn (server-stashed). */
  promptText?: string;
  /** Activity label when the prompt was sent (e.g. "contract draft"). */
  promptLabel?: string;
  /** Buffered SDK tool calls for this agent turn — shown via a Tools toggle on the bubble. */
  toolTrace?: Array<{ tool: string; ok: boolean; preview: string; ts?: number }>;
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

export type TodoStatus = "open" | "claimed" | "committed" | "stale" | "skipped" | "pending-commit";

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
  proposedFiles?: string[];
  proposedHunks?: any;
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
  | "crashed"  // abrupt kill / server death (maps to failed phase)
  | "cap:wall-clock"
  | "cap:commits"
  | "cap:todos"
  | "cap:tokens"
  | "cap:quota"
  | "early-stop"
  | "no-progress"
  | "partial-progress";

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
  runId?: string;
  repoUrl: string;
  localPath: string;
  preset: string;
  model: string;
  agentCount?: number;
  rounds?: number;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  wastedWallClockMs?: number;
  stopReason: StopReason;
  stopDetail?: string;
  commits: number;
  staleEvents: number;
  skippedTodos: number;
  totalTodos: number;
  filesChanged: number;
  finalGitStatus: string;
  finalGitStatusTruncated: boolean;
  /** Stream loop/truncate aggregate from transcript (optional, newer runs). */
  streamIntegrity?: {
    anomalyEventCount: number;
    agentsAffected: string[];
    maxAgentTextChars: number;
    maxAgentThoughtChars: number;
    events: Array<{ agentId?: string; kind: string; detail: string; ts?: number }>;
    hadLoopCollapse: boolean;
    hadHardTruncate: boolean;
  };
  /** Apply/repair miss aggregate (optional, newer runs). */
  applyIntegrity?: {
    attempts: number;
    applied: number;
    missByKind: Record<string, number>;
    repairSuccesses: number;
    repairFailures: number;
    /** First-pass misses recovered via deterministic uniqueCandidates. */
    missRecoveredDet?: number;
    /** First-pass misses recovered via LLM grounded repair. */
    missRecoveredLlm?: number;
    /** Misses that remained terminal after recovery. */
    missTerminal?: number;
  };
  /** Brain OS agentic dispatch metrics (optional, newer runs). */
  brainOs?: {
    dispatches: number;
    resolved: number;
    partial: number;
    blocked: number;
    needsHuman: number;
    helpersSpawned: number;
    childDispatches: number;
    tokensIn: number;
    tokensOut: number;
    wallMs: number;
    effectsApplied: number;
    effectsRejected: number;
  };
  /** Run resilience rollup (control plane). */
  resilience?: {
    stallGates: number;
    toolCoaches: number;
    brainOsEvents: number;
    stopActions: number;
    backoffActions: number;
    score: number;
    label: string;
  };
  /** Cycle fail taxonomy + empty-execution streaks (optional, RR-D). */
  cycleIntegrity?: {
    cyclesCompleted: number;
    emptyExecutionCycles: number;
    failByBucket: Record<string, number>;
    /** Attempt-level fail events. */
    todosFailed: number;
    /** Distinct todos that failed at least once. */
    todosFailedUnique?: number;
    todosSucceeded: number;
    lastEmptyStreak: number;
    maxEmptyStreak: number;
  };
  /** Research blackout / catalog inject stats (optional, RR-C). */
  researchIntegrity?: {
    searchAttempts: number;
    searchSuccesses: number;
    failByBackend: Record<string, number>;
    http403Count: number;
    catalogInjects: number;
    blackoutActive: boolean;
    usableBriefs: number;
    unusableBriefs: number;
    budgetExhausted: boolean;
    consecutiveFailures: number;
  };
  agents: PerAgentStat[];
  contract?: ExitContract;
  // Brain chat history persisted for recovery/FAB continuity (per-run).
  brainChatHistory?: Array<{ role: string; content: string }>;
  // Task #65 (2026-04-24): persisted transcript snapshot at run-end.
  // Optional — older summaries don't have it. Capped server-side at
  // TRANSCRIPT_MAX_ENTRIES; transcriptTruncated=true when capped.
  transcript?: TranscriptEntry[];
  transcriptTruncated?: boolean;
  // V2 reducer snapshot at run end. Blackboard-only. After cutover
  // Phase 1a (2026-04-28), divergence tracking is gone — the field
  // captures the reducer's terminal phase + pause state.
  v2State?: {
    phase: string;
    enteredAt: number;
    detail?: string;
    pausedReason?: string;
  };
  // V2 TodoQueue snapshot at run end. Blackboard-only. After cutover
  // Phase 1a, divergence vs V1 Board is no longer recorded — only
  // the queue's terminal counts.
  v2QueueState?: {
    counts: {
      pending: number;
      inProgress: number;
      completed: number;
      failed: number;
      skipped: number;
      total: number;
    };
  };
  // Phase 4a of #243: the topology used for this run, threaded from
  // RunConfig.topology. Optional — older summaries written before this
  // landed don't have it (the modal falls back to a synthesized
  // best-guess from preset+agentCount in that case).
  topology?: import("../../shared/src/topology").Topology;
  deliverables?: Array<{ path: string; status: "created" | "modified" }>;
  startCommand?: string;
  /**
   * Full start-form snapshot (directive, topology, MCP, caps, flags).
   * Preferred source for "Load params on Start page".
   */
  startConfig?: import("@ollama-swarm/shared/startConfigSnapshot").StartConfigSnapshot;
  userDirective?: string;
  plannerTools?: boolean;
  webTools?: boolean;
  mcpServers?: string;
  autoApprove?: boolean;
  writeMode?: "none" | "single" | "multi";
  conflictPolicy?: "merge" | "sequential" | "vote" | "judge" | "pick";
  councilSharedExplore?: boolean;
  councilSharedResearch?: boolean;
  councilReconcile?: "revise" | "vote" | "judge";
  verifyCommand?: string;
  preflightDryRun?: boolean;
  hunkRag?: boolean;
  dynamicRolePicker?: boolean;
  mentionContracts?: boolean;
  bestOfNTurn?: number;
  wallClockCapMs?: number;
  ambitionTiers?: number | string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  controlAdvice?: Array<{
    ts: number;
    kind: string;
    action?: string;
    source?: string;
    rationale: string;
    plannerHint?: string;
    agentId?: string;
    tool?: string;
  }>;
  /** Tail of peer/hierarchy/control deliberation for hydrate + history. */
  deliberation?: Array<{
    ts: number;
    layer: string;
    verdict: string;
    subject: string;
    claim?: string;
    validationReason?: string;
    proposer?: string;
    validator?: string;
  }>;
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
  | { type: "agent_state"; agent: AgentState; runId?: string }
  /** Full roster replace — empty clears ghosts (pipeline phase handoff / killAll). */
  | { type: "agents_roster"; agents: AgentState[]; runId?: string }
  | {
      type: "swarm_state";
      phase: SwarmPhase;
      round: number;
      runId?: string;
      planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
    }
  | { type: "agent_streaming"; agentId: string; agentIndex: number; text: string; runId?: string }
  | { type: "agent_streaming_end"; agentId: string; runId?: string }
  | {
      type: "agent_activity";
      agentId: string;
      agentIndex: number;
      phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
      ts: number;
      activityId?: string;
      kind?: string;
      label?: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
      runId?: string;
    }
  | { type: "error"; message: string }
  | { type: "todo_posted"; todo: Todo }
  | { type: "todo_claimed"; todoId: string; claim: Claim }
  | { type: "todo_committed"; todoId: string }
  | { type: "todo_failed"; todoId: string; reason: string; replanCount: number }
  | { type: "todo_skipped"; todoId: string; reason: string }
  | { type: "todo_proposed"; todo: Todo }
  | { type: "todo_reverted"; todoId: string; reason: string }
  // W17: model shift event for failover visibility in UI
  | {
      type: "model_shift";
      agentId: string;
      agentIndex: number;
      fromModel: string;
      toModel: string;
      reason: string;
      rawError?: string;
    }
  | {
      type: "todo_replanned";
      todoId: string;
      description: string;
      expectedFiles: string[];
      replanCount: number;
      // Unit 44b: optional anchor revision. Server emits it when the
      // replanner explicitly revised anchors; absent means "keep prior."
      expectedAnchors?: string[];
    }
  | { type: "finding_posted"; finding: Finding }
  | { type: "queue_state"; snapshot: BoardSnapshot; counts: BoardCountsDTO }
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
  // #299: user submitted a mid-run directive amendment. Emitted by
  // the server's POST /api/swarm/amend handler so all WS clients
  // (multiple tabs viewing the same run) mirror the addition.
  | {
      type: "directive_amended";
      runId: string;
      ts: number;
      text: string;
    }
  | {
      type: "run_reconfigured";
      runId: string;
      ts: number;
      message: string;
      changes: {
        rounds?: { from?: number; to: number };
        wallClockCapMs?: { from?: number; to: number };
        tokenBudget?: { from?: number; to: number };
        thinkGuardReferee?: import("@ollama-swarm/shared/thinkGuardBudget").ThinkGuardRefereeReconfigChanges;
      };
    }
  | {
      type: "swarm_control_advice";
      ts: number;
      kind: "stall_gate" | "tool_coach" | "brain_os";
      action?: "backoff" | "retry" | "stop";
      source?: "rule" | "arbitrator" | "brain_os";
      rationale: string;
      plannerHint?: string;
      agentId?: string;
      tool?: string;
      conflictKind?: string;
      status?: string;
    }
  | {
      type: "brain_os_helpers";
      runId: string;
      ts: number;
      helpers: Array<{
        helperId: string;
        kind: string;
        privilege: string;
        depth: number;
        model?: string;
        startedAt: number;
        phase?: string;
      }>;
      action: "start" | "end";
      helperId: string;
    }
  | {
      type: "deliberation_transaction";
      transaction: {
        id: string;
        ts: number;
        runId: string;
        layer: "hierarchy" | "peer" | "control";
        preset?: string;
        subject: string;
        claim: string;
        proposer: string;
        validator?: string;
        verdict: "claim" | "challenge" | "validate" | "approve" | "deny" | "abstain";
        validationReason?: string;
        evidence?: string[];
        schemaVersion: 1;
      };
    }
  // #295 + #301: live directive-conformance sample. Per-poll grader
  // metadata enriches the IdentityStrip tooltip infographic.
  | {
      type: "conformance_sample";
      runId: string;
      ts: number;
      score: number;
      smoothedScore: number;
      reason?: string;
      graderModel?: string;
      latencyMs?: number;
      excerptChars?: number;
      windowScores?: number[];
      anchorOverlap?: number;
      offGraphPaths?: string[];
      recoverySuggested?: boolean;
    }
  // #302 Phase B: independent embedding-similarity drift sample.
  | {
      type: "drift_sample";
      runId: string;
      ts: number;
      similarity: number;
      smoothedSimilarity: number;
      embeddingModel: string;
      excerptChars: number;
      windowSimilarities: number[];
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
      topology?: import("../../shared/src/topology").Topology;
      // Caps from run_started for setup bar / review hydration.
      wallClockCapMin?: string;
      ambitionTiers?: string;
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
  // Deliverables: files created or meaningfully changed by this run.
  // Created = new file; Modified = existing file edited. Empty for
  // discussion presets (no code changes). Optional for back-compat.
  deliverables?: Array<{ path: string; status: "created" | "modified" }>;
}
  // Direction 1 Phase 1: emitted after rubric grading completes at run-end.
  | {
      type: "outcome_scored";
      runId: string;
      score: number;
      verdict: "ship-quality" | "needs-revision" | "fundamentally-flawed";
      dimensions: Array<{ id: string; label: string; score: number; note: string }>;
    }
  // Phase 10: phase_started / phase_completed removed completely.
  // No explicit phase state emitters for composite runs.

// Shared shape returned by GET /api/swarm/preflight. Drives both the
// inline PreflightPreview under the Parent folder field AND the
// pre-Start confirmation modal (StartConfirmModal) that gates Start
// when an existing clone is detected.
export interface ProviderKeyWarning {
  provider: string;
  model: string;
  envVar: string;
  message: string;
}

export type ProviderProbeStatus =
  | "unconfigured"
  | "idle"
  | "ok"
  | "degraded"
  | "rate_limited"
  | "down";

export interface ProviderHealthSummary {
  hasKey: boolean;
  probeStatus: ProviderProbeStatus;
  lastError?: string;
  lastProbeAt?: number;
  lastProbeMs?: number;
}

export interface ProviderProbeWarning {
  provider: string;
  model: string;
  probeStatus: ProviderProbeStatus;
  message: string;
}

export interface PreflightState {
  destPath: string;
  exists: boolean;
  isGitRepo: boolean;
  alreadyPresent: boolean;
  priorCommits: number;
  priorChangedFiles: number;
  priorUntrackedFiles: number;
  blocker?: "not-git-repo";
  providerWarnings?: ProviderKeyWarning[];
  providerHealth?: Record<string, ProviderHealthSummary>;
  providerProbeWarnings?: ProviderProbeWarning[];
}

export interface ProviderProbeHealth {
  probeStatus: ProviderProbeStatus;
  probeStage: string;
  lastProbeAt?: number;
  lastProbeMs?: number;
  lastError?: string;
  modelCount?: number;
  envVars: string[];
  source: string;
}

export interface ProviderRuntimeHealth {
  circuit: string;
  headroom: number;
  queueDepth: number;
  failures: number;
  gatewayEnabled: boolean;
}

export interface ProviderStatusEntry {
  available: boolean;
  hasKey: boolean;
  health: ProviderProbeHealth;
  runtime: ProviderRuntimeHealth;
}

export interface ProvidersApiResponse {
  gateway?: {
    gatewayEnabled: boolean;
    fairScheduling: boolean;
    totalQueueDepth: number;
    providers?: Record<string, ProviderRuntimeHealth & { provider: string }>;
  };
  meta?: {
    probedAt: number;
    nextProbeAt: number;
    schedulerRunning: boolean;
    staleAfterMs: number;
  };
  ollama?: ProviderStatusEntry;
  "ollama-cloud"?: ProviderStatusEntry;
  anthropic?: ProviderStatusEntry;
  openai?: ProviderStatusEntry;
  opencode?: ProviderStatusEntry;
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
  // Phase 4b of #243: topology from run_started. SwarmView reads this
  // to color the AgentPanel cards in topology row order with the
  // exact role + per-row model. Optional during rollout.
  topology?: import("../../shared/src/topology").Topology;
  // Caps synced from setup form for blackboard/advanced runs
  wallClockCapMin?: string;
  ambitionTiers?: string;
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

export type ResolvedThinkGuardRefereeBudget =
  import("@ollama-swarm/shared/thinkGuardBudget").ResolvedThinkGuardRefereeBudget;

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
  filesChanged?: number;
  skippedTodos?: number;
  staleEvents?: number;
  agentCount?: number;
  hasContract: boolean;
  isActive: boolean;
  // Task #36: app-level runId (uuid) from the summary.json. Absent on
  // pre-task-36 runs so the dropdown renders "—" for legacy rows.
  runId?: string;
  // Phase 4a of #243: topology surfaced in the dropdown row so users
  // can see the agent specs (1 planner + 4 workers + 1 auditor) at a
  // glance. Optional — older summaries don't carry it; the row shows
  // "—" in that case.
  topology?: import("../../shared/src/topology").Topology;
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
  /** Last agent_activity per agent for sidebar reconnect hydrate. */
  agentActivity?: Record<
    string,
    {
      phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
      ts: number;
      startedAt: number;
      activityId?: string;
      kind?: string;
      label?: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
      history?: Array<{
        phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
        ts: number;
        kind?: string;
        label?: string;
        activityId?: string;
      }>;
    }
  >;
  // Phase 2a: stigmergy pheromone table for catch-up hydration.
  pheromones?: Record<string, PheromoneEntry>;
  // Phase 2d: map-reduce mapper slice assignments for catch-up.
  mapperSlices?: Record<string, string[]>;
  regions?: RegionStatus;
  drainEligible?: boolean;
  drainIneligibleReason?: string;
  earlyStopDetail?: string;
  capsRemaining?: {
    wallClockMsRemaining?: number;
    tokenBudgetRemaining?: number;
  };
  planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
  thinkGuardReferee?: ResolvedThinkGuardRefereeBudget;
  pipelinePhase?: {
    index: number;
    count: number;
    preset: string;
    chain?: string;
  };
}

export interface RegionStatus {
  lifecycle: "idle" | "booting" | "active" | "draining" | "stopped";
  planner: "idle" | "thinking" | "waiting";
  workers: { total: number; thinking: number; idle: number };
  queue: { open: number; claimed: number; committed: number; stale: number };
  caps: { paused: boolean; reason?: string };
}
