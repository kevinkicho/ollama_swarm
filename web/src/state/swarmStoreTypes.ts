// Swarm store types — extracted from store.ts for modularity.

import type {
  AgentState,
  BoardSnapshot,
  Claim,
  CloneState,
  ExitContract,
  Finding,
  LatencySample,
  PheromoneEntry,
  RunConfigSnapshot,
  RunSummary,
  SwarmPhase,
  Todo,
  TranscriptEntry,
} from "../types";
import type { ChatMessage } from "../components/BrainStartChat";
import type { AgentActivityRecord } from "./agentActivityProjection.js";

export type { AgentActivityRecord } from "./agentActivityProjection.js";

// #295 + #301: latest conformance score the UI renders. `samples`
// powers the sparkline; per-sample grader metadata feeds the
// tooltip infographic.
export interface ConformanceSample {
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

// #299: user-submitted mid-run directive amendments. Cleared on
// run reset.
export interface DirectiveAmendment {
  ts: number;
  text: string;
}

// #302 Phase B: embedding-similarity drift sample (the second signal
// alongside ConformanceSample). Independent measurement methodology
// — pure cosine similarity of directive vs recent transcript.
export interface DriftSample {
  ts: number;
  similarity: number;
  smoothedSimilarity: number;
  embeddingModel: string;
  excerptChars: number;
  windowSimilarities: number[];
}

/** Live run-resilience control plane (stall recovery, thrash brakes, Brain OS). */
export interface SwarmControlAdvice {
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

/** Live peer/hierarchy/control deliberation transactions. */
export interface DeliberationAdvice {
  id?: string;
  ts: number;
  layer: "hierarchy" | "peer" | "control" | string;
  verdict: string;
  subject: string;
  claim?: string;
  validationReason?: string;
  proposer?: string;
  validator?: string;
}

// Task #46: metadata threaded into the transcript divider that
// resetForNewRun appends. All optional — if missing, we fall back
// to the plain "— new run started —" text for back-compat with any
// caller (tests, future code paths) that doesn't have the info.
export interface RunStartDividerInfo {
  runId?: string;
  preset?: string;
  plannerModel?: string;
  workerModel?: string;
  agentCount?: number;
  repoUrl?: string;
}

// T-Item-PerRunStore (2026-05-04): exported so the per-run
// Provider + the shared event applier can type-narrow against it.
export interface SwarmStore {
  phase: SwarmPhase;
  planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
  round: number;
  agents: Record<string, AgentState>;
  transcript: TranscriptEntry[];
  streaming: Record<string, string>;
  // Task #176 Phase A+B: per-agent streaming metadata. Drives the
  // "thinking N.Ns…" subtitle (lastTextAt → wall-clock since last
  // chunk) and the post-completion persistent bubble (status="done"
  // keeps the bubble visible with ✓ until transcript_append takes
  // over the same DOM position).
  streamingMeta: Record<
    string,
    { startedAt: number; lastTextAt: number; status: "live" | "done"; endedAt?: number }
  >;
  /** Prompt-session lifecycle from agent_activity WS events. */
  agentActivity: Record<string, AgentActivityRecord>;
  todos: Record<string, Todo>;
  findings: Finding[];
  contract?: ExitContract;
  summary?: RunSummary;
  // Topbar error banner. Carries runId at error-time so a stale error
  // from a long-dead run is obvious to the user (and can be dismissed).
  error?: { message: string; runId?: string; ts: number };
  latency: Record<string, LatencySample[]>;
  // #295: rolling window of conformance scores for the live gauge.
  // Empty array when no run is active OR the run had no userDirective
  // (server doesn't emit samples in those cases).
  conformance: ConformanceSample[];
  // #302 Phase B: embedding-similarity drift samples (second signal
  // alongside conformance). Empty when embedding model isn't pulled.
  drift: DriftSample[];
  // #299: user-submitted mid-run directive amendments for the
  // active run. Cleared on reset/resetForNewRun.
  amendments: DirectiveAmendment[];
  // Brain chat history, persisted per-run in the per-run store.
  brainChatHistory: ChatMessage[];
  useCaseFilters: string[];
  // Unit 47: latest clone_state event for the current run, or
  // undefined before the runner emits it. UI uses this to show the
  // "you're resuming an existing clone" banner.
  cloneState?: CloneState;
  // Unit 47: user has dismissed the resume banner for this run; the
  // banner stays hidden until the next reset (new run start).
  cloneBannerDismissed: boolean;
  // Unit 52a: wall-clock ms-since-epoch at which the orchestrator
  // started this run. Anchors the runtime ticker. Undefined when no
  // run has fired this session OR after reset().
  runStartedAt?: number;
  // Unit 52c: snapshot of the run's config (preset, models, paths)
  // captured from the same run_started event. Drives the
  // run-identity strip.
  runConfig?: RunConfigSnapshot;
  /** Live think-guard referee budget (resolved defaults + usage). */
  thinkGuardReferee?: import("../types").ResolvedThinkGuardRefereeBudget;
  /** Rolling window of swarm_control_advice WS events. */
  controlAdvice: SwarmControlAdvice[];
  /** Rolling window of deliberation_transaction WS events. */
  deliberation: DeliberationAdvice[];
  /** Live Brain OS helpers (sidebar). */
  brainOsHelpers: Array<{
    helperId: string;
    kind: string;
    privilege: string;
    depth: number;
    model?: string;
    startedAt: number;
    phase?: string;
  }>;
  // Caps from setup (wall clock, ambition tiers for blackboard) synced to
  // global store so other panels / review / bar can see them live.
  wallClockCapMin?: string;
  ambitionTiers?: string;
  // Unit 52d: app-level run id (uuid) minted at run-start. Distinct
  // from opencode session ids. Used in the identifiers row for
  // click-to-copy + future cross-referencing of per-run artifacts.
  runId?: string;
  // Phase 2a: stigmergy pheromone table. Empty for non-stigmergy
  // presets. Keyed by file path.
  pheromones: Record<string, PheromoneEntry>;
  // Phase 2d: map-reduce mapper slice assignments. Keyed by agentId.
  mapperSlices: Record<string, string[]>;
  // Direction 1 Phase 1: outcome score from rubric grading at run end.
  outcome?: { score: number; verdict: string; dimensions: Array<{ id: string; label: string; score: number; note: string }> };
  /**
   * When true, Transcript renders a plain DOM list (no virtualization).
   * Set on live runs and kept through stop/terminal so phase changes
   * cannot flip to virtual mid-session (source of hidden/gapped messages).
   */
  transcriptPlainListLatched: boolean;
  /** Soft-drain eligibility from last status snapshot (server). */
  drainEligible?: boolean;
  drainIneligibleReason?: string;
  capsRemaining?: {
    wallClockMsRemaining?: number;
    tokenBudgetRemaining?: number;
  };
  /** RR-D: durable progress heartbeat from /status. */
  progressHeartbeat?: {
    lastProductiveAt: number;
    progressQuietMs: number;
  };
  earlyStopDetail?: string;
  /** Active composite pipeline sub-phase (from /status). */
  pipelinePhase?: {
    index: number;
    count: number;
    preset: string;
    chain?: string;
  };

  setPhase: (
    phase: SwarmPhase,
    round: number,
    opts?: {
      clearTranscriptOnIdle?: boolean;
      planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
    },
  ) => void;
  latchTranscriptPlainList: () => void;
  /** Status-snapshot fields for drain tooltip + remaining caps. */
  setBrainOsHelpers: (
    helpers: SwarmStore["brainOsHelpers"],
  ) => void;
  setRunHealthFromStatus: (patch: {
    drainEligible?: boolean;
    drainIneligibleReason?: string;
    capsRemaining?: SwarmStore["capsRemaining"];
    earlyStopDetail?: string;
    pipelinePhase?: SwarmStore["pipelinePhase"] | null;
    progressHeartbeat?: SwarmStore["progressHeartbeat"] | null;
  }) => void;
  upsertAgent: (a: AgentState) => void;
  /** Replace entire agent roster (pipeline handoff / killAll). */
  replaceAgents: (agents: AgentState[]) => void;
  appendEntry: (e: TranscriptEntry) => void;
  /** Batch-load transcript from REST hydrate — one set() to avoid virtual-list flicker. */
  hydrateTranscriptEntries: (entries: TranscriptEntry[]) => void;
  clearTranscript: () => void;
  removeTranscriptEntry: (id: string) => void;
  setStreaming: (agentId: string, text: string) => void;
  clearStreaming: (agentId: string) => void;
  // Task #176 Phase A: agent_streaming_end now marks the entry as
  // "done" (visual ✓ + fade) but doesn't remove it. The eventual
  // transcript_append takes over that DOM position naturally via
  // appendEntry's existing delete-from-streaming side effect.
  markStreamingEnded: (agentId: string) => void;
  setAgentActivity: (ev: {
    agentId: string;
    phase: AgentActivityRecord["phase"];
    ts: number;
    activityId?: string;
    kind?: string;
    label?: string;
    attempt?: number;
    maxAttempts?: number;
    reason?: string;
  }) => void;

  upsertTodo: (t: Todo) => void;
  applyClaim: (todoId: string, claim: Claim) => void;
  markCommitted: (todoId: string) => void;
  markStale: (todoId: string, reason: string, replanCount: number) => void;
  markSkipped: (todoId: string, reason: string) => void;
  applyReplan: (
    todoId: string,
    description: string,
    expectedFiles: string[],
    replanCount: number,
    expectedAnchors?: string[],
  ) => void;
  appendFinding: (f: Finding) => void;
  replaceBoard: (snapshot: BoardSnapshot) => void;
  setContract: (c: ExitContract) => void;
  setSummary: (s: RunSummary) => void;
  pushLatencySample: (agentId: string, sample: LatencySample) => void;
  // #295: append a conformance sample to the rolling window.
  pushConformanceSample: (sample: ConformanceSample) => void;
  // #302: append an embedding-drift sample to the rolling window.
  pushDriftSample: (sample: DriftSample) => void;
  // #299: append a mid-run amendment received via WS.
  pushAmendment: (amendment: DirectiveAmendment) => void;
  pushControlAdvice: (advice: SwarmControlAdvice) => void;
  replaceControlAdvice: (advice: SwarmControlAdvice[]) => void;
  pushDeliberation: (row: DeliberationAdvice) => void;
  replaceDeliberation: (rows: DeliberationAdvice[]) => void;
  setCloneState: (c: CloneState) => void;
  dismissCloneBanner: () => void;
  setRunStartedAt: (ts: number) => void;
  setRunConfig: (c: RunConfigSnapshot) => void;
  patchRunConfig: (patch: Partial<RunConfigSnapshot>) => void;
  setThinkGuardReferee: (b: import("../types").ResolvedThinkGuardRefereeBudget | undefined) => void;
  // Brain chat (FAB + per-run history + suggest injection)
  setBrainChatHistory: (history: ChatMessage[]) => void;
  appendBrainChatMessage: (msg: ChatMessage) => void;
  setRunId: (id: string) => void;

  setUseCaseFilters: (filters: string[]) => void;

  upsertPheromone: (file: string, state: PheromoneEntry) => void;
  setMapperSlices: (slices: Record<string, string[]>) => void;
  setOutcome: (outcome: { score: number; verdict: string; dimensions: Array<{ id: string; label: string; score: number; note: string }> }) => void;

  setError: (msg: string | undefined) => void;
  // Dismiss the topbar error banner (sets error → undefined).
  dismissError: () => void;
  reset: () => void;
  // Task #37 (partial): lighter reset fired on WS run_started — drops
  // agents/streaming/latency only so prior transcript stays readable.
  // Task #46: accepts run metadata so the transcript divider can
  // render the runId + preset + models + agent count + repo instead
  // of a plain "— new run started —" line.
  resetForNewRun: (info?: RunStartDividerInfo) => void;
}
