// RunSummary types + constants — extracted from summary.ts
// (shape assembly remains in summary.ts).

import type { ExitContract } from "./types.js";

export const FINAL_GIT_STATUS_MAX = 4_000;
// Task #65: transcript persistence cap. Typical discussion runs land
// 10-100 entries; blackboard can hit 200-500. 1000 is comfortable
// headroom; runs beyond it set transcriptTruncated=true and keep the
// FIRST 1000 (head, not tail — the early system + setup entries are
// usually the most useful for review).
export const TRANSCRIPT_MAX_ENTRIES = 1_000;

/** Minimum quota-classified errors in the terminal window to label cap:quota. */
export const TERMINAL_QUOTA_MIN_ERRORS = 5;
export const TERMINAL_QUOTA_TRANSCRIPT_TAIL = 30;

export type StopReason =
  | "completed"
  | "user"
  | "crash"
  | "crashed"   // abrupt process/server kill, hard SIGKILL, no graceful shutdown (no exception caught)
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
  // Unit 21: per-agent attempt + latency stats sourced from
  // promptWithRetry's onTiming/onRetry hooks. `totalAttempts` includes
  // retries; `totalRetries` is the count of retry firings (so e.g. an
  // agent that succeeded on attempt 2 contributes totalAttempts=2,
  // totalRetries=1). Latency is computed only over SUCCESSFUL attempts
  // — failed attempts are typically headers-timeout aborts that don't
  // tell you anything meaningful about model speed. All optional /
  // null when no data was collected (older summaries, runs that
  // crashed before any prompt fired).
  totalAttempts?: number;
  totalRetries?: number;
  successfulAttempts?: number;
  meanLatencyMs?: number | null;
  p50LatencyMs?: number | null;
  p95LatencyMs?: number | null;
  // Task #66 (2026-04-24): per-agent commit + line counts. Blackboard-only
  // — discussion presets don't write code so these stay 0/undefined.
  // commits = how many todos this agent committed; linesAdded / linesRemoved
  // = sum across the agent's committed hunks (replace counts both, create
  // and append count added only). Optional for back-compat with summaries
  // written before this lands.
  commits?: number;
  linesAdded?: number;
  linesRemoved?: number;
  // Task #67 (2026-04-24): per-agent rejected-work + recovery counters.
  // Blackboard-only. Surface in the modal so users can spot WHY a worker
  // produced 0 commits despite many turns (was it bad todos? bad model
  // output? CAS races?). All optional / blackboard-only.
  //   rejectedAttempts = sum of: declined-todo + invalid-JSON-after-repair
  //                      + CAS-mismatch + hunk-apply-fail + BOM-detected
  //                      + critic-reject. One number that measures
  //                      "wasted work this agent produced".
  //   jsonRepairs      = count of JSON-invalid first attempts that
  //                      triggered the repair-prompt path (informational —
  //                      a successful repair still counts).
  //   promptErrors     = count of hard errors thrown by this agent's
  //                      prompts (network errors, abort, etc.) that
  //                      escaped past promptWithRetry.
  rejectedAttempts?: number;
  jsonRepairs?: number;
  promptErrors?: number;
}

export interface RunSummary {
  /**
   * Task #36: app-level run id (uuid) minted by the Orchestrator at
   * run-start (Unit 52d). Optional on the type so summaries written
   * before task #36 stay shape-compatible; new runs always populate it.
   * Enables the run-history dropdown to cross-reference historical
   * summaries against the live IdentityStrip runId chip.
   */
  runId?: string;
  repoUrl: string;
  localPath: string;
  preset: string;
  model: string;
  // Unit 33: agentCount + rounds surfaced at the top level so
  // cross-preset comparisons don't have to derive them. Optional for
  // backward compat with any pre-Unit-33 summary consumer that still
  // expects the old shape (internal only — no external consumers
  // today, but the defensiveness is cheap).
  agentCount?: number;
  rounds?: number;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  /** Estimated wall-clock time lost to stale todos. */
  wastedWallClockMs: number;
  stopReason: StopReason;
  stopDetail?: string;
  // Unit 33: blackboard-specific board stats are optional. Non-blackboard
  // runs omit them rather than emitting zeros (zeros would read as "no
  // work committed" which is technically true but visually misleading —
  // those presets can't commit work regardless). Callers checking a
  // summary's preset to know which fields to expect.
  commits?: number;
  staleEvents?: number;
  skippedTodos?: number;
  totalTodos?: number;
  filesChanged: number;
  finalGitStatus: string;
  finalGitStatusTruncated: boolean;
  // Task #163 (2026-04-26): run-level token totals. Computed accurately
  // at summary time from tokenTracker.recent[] filtered by ts in the run
  // window (startedAt → endedAt). Independent of per-agent tokensIn/Out
  // (which are approximate for parallel paths). Optional for back-compat
  // with summaries written before this lands.
  totalPromptTokens?: number;
  totalResponseTokens?: number;
  /**
   * Stream-integrity aggregate (loop collapses, hard truncates, peak sizes).
   * Optional for back-compat with older summary.json files.
   */
  streamIntegrity?: import("../../../../shared/src/streamIntegrityReport.js").StreamIntegrityReport;
  /**
   * Apply/repair integrity aggregate (miss kinds, repair outcomes).
   * Optional for back-compat with older summary.json files.
   */
  applyIntegrity?: import("../../../../shared/src/applyIntegrityReport.js").ApplyIntegrityReport;
  /** RR-D: cycle fail taxonomy + empty-execution streaks (optional). */
  cycleIntegrity?: import("../../../../shared/src/cycleIntegrityReport.js").CycleIntegrityReport;
  /** RR-C: research blackout / catalog inject stats (optional). */
  researchIntegrity?: import("../research/researchBudget.js").ResearchIntegrityReport;
  agents: PerAgentStat[];
  // Task #65 (2026-04-24): persist the in-memory transcript at run-end
  // so the history modal / review view can replay what happened.
  // Optional for back-compat with summaries written before this lands.
  // Truncated server-side at TRANSCRIPT_MAX_ENTRIES if a runaway run
  // produces an unreasonable transcript (defensive — typical runs are
  // 10-100 entries; blackboard can hit 200-500).
  transcript?: import("../../types.js").TranscriptEntry[];
  transcriptTruncated?: boolean;
  /** Phase 11c: the exit contract as it stood at run end, including per-criterion
   *  verdicts applied by the auditor. Undefined when the first-pass contract
   *  prompt failed to parse and the run fell back to drain-exit. Blackboard-only. */
  contract?: ExitContract;
  // Unit 34: ambition-ratchet output. Blackboard-only. Absent when the
  // ratchet is disabled / never fired. `maxTierReached` is the highest
  // tier number the run touched (1 for runs that never ratcheted).
  maxTierReached?: number;
  tiersCompleted?: number;
  tierHistory?: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
  wallClockMs: number;
  /** Estimated wall-clock time lost to stale todos. Computed as
   *  staleCount × estimatedMeanTurnMs (conservative: 15s per stale turn).
   *  Useful for computing the dollar cost of cascade failures. */
  wastedWallClockMs: number;
    startedAt: number;
    endedAt: number;
  }>;
  // V2 reducer snapshot at run end. Blackboard-only. After cutover
  // Phase 1a (2026-04-28), divergence tracking is gone — the field
  // now records the reducer's final phase + pause state for forward
  // Composite phase support notes (legacy).
  currentPhase?: {
    index: number;
    preset: string;
    status?: 'running' | 'complete' | 'failed';
  };
  phases?: Array<{
    index: number;
    preset: string;
    status?: string;
    startedAt?: number;
    endedAt?: number;
    deliverable?: string;
  }>;
  // compat with Phase 1b (UI-driven by V2 phase). Optional for
  // back-compat with summaries written before this field landed.
  v2State?: {
    phase: string;
    enteredAt: number;
    detail?: string;
    pausedReason?: string;
  };
  // V2 TodoQueue snapshot at run end. Blackboard-only. After
  // cutover Phase 1a, divergence vs V1 board is no longer recorded —
  // the field captures the queue's final counts for parity with
  // Board.counts() so consumers reading either side see identical
  // numbers.
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
  // Phase 4a of #243: persist the topology used for this run so
  // history (dropdown chip, modal full grid) and review-mode
  // hydration can show the exact agent specs without re-deriving
  // from preset+agentCount. Optional for back-compat with summaries
  // written pre-#243.
  topology?: import("../../../../shared/src/topology.js").Topology;
  // R15 + R16 wiring (2026-05-04): structured RCA + 0-100 health
  // score appended at run-end. RCA is empty string when the run was
  // a clean success (no attention needed). Both optional for back-
  // compat with summaries written before this lands.
  rca?: import("../autoRca.js").RcaReport;
  healthScore?: import("../runHealthScore.js").RunHealthScore;
  startCommand?: string;
  // Direction 1: run outcome scoring. Multi-dimensional rubric grade
  // appended at run-end by outcomeScorer. Optional for back-compat
  // with summaries written before this lands.
  outcome?: import("../outcomeScorer.js").RunOutcomeSummary;
  // Deliverables: files created or meaningfully changed by the run.
  // Populated from git diff --name-status at run-end. Each entry is
  // either "created" (new file) or "modified" (existing file changed).
  // Empty for discussion presets (no code changes). Optional for
  // back-compat with summaries written before this lands.
  deliverables?: Array<{ path: string; status: "created" | "modified" }>;
  /** Swarm control center advice emitted during the run (history hydrate). */
  controlAdvice?: import("@ollama-swarm/shared/swarmControl/controlAdvice").SwarmControlAdviceRecord[];
  /**
   * Peer/hierarchy/control deliberation transactions (truncated tail).
   * Full history lives in logs/<runId>/deliberation.jsonl.
   */
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
  /** User directive from setup / start payload. Enables Resume to replay intent. */
  userDirective?: string;
  plannerTools?: boolean;
  webTools?: boolean;
}

export interface SummaryConfig {
  repoUrl: string;
  localPath: string;
  preset: string;
  model: string;
  /** Task #36: runId threaded from cfg.runId so buildSummary can include
   *  it in the RunSummary output. Optional — builders that don't know
   *  it (tests, older call paths) just omit it. */
  runId?: string;
  /** CLI command that started this run, for display in run history. */
  startCommand?: string;
  /** User directive from setup / start payload (resume fidelity). */
  userDirective?: string;
  plannerTools?: boolean;
  webTools?: boolean;
}

export interface SummaryCounts {
  committed: number;
  skipped: number;
  stale: number;
  total: number;
}

export interface BuildSummaryInput {
  config: SummaryConfig;
  /** Unit 33: echoed to the summary top-level so cross-preset
   *  comparison tooling has parity with non-blackboard presets. */
  agentCount?: number;
  rounds?: number;
  startedAt: number;
  endedAt: number;
  /** True if the run threw; takes precedence over every other stop reason. */
  crashMessage?: string;
  /** Set by `checkCaps` when a hard cap tripped. Parsed for cap sub-type. */
  terminationReason?: string;
  /** True if lifecycle is in `stopping` (or a cap flipped the flag). Distinguished via
   *  terminationReason: user stops leave it unset, cap stops set it. */
  stopping: boolean;
  /** Sticky: set on hard stop and survives until the next run start. Covers the race
   *  where planAndExecute's finally writes a summary after stop() but lifecycle already
   *  moved on, or while still `draining`. */
  userStopRequested?: boolean;
  /** True once drain() entered; distinguishes soft-stop from natural completion. */
  wasDrained?: boolean;
  /** Phase 11c: short explanation for why a successful "completed" run
   *  terminated, e.g. "all contract criteria satisfied" or "auditor invocation
   *  cap reached". Populated into `stopDetail` on the completed branch only. */
  completionDetail?: string;
  board: SummaryCounts;
  staleEvents: number;
  filesChanged: number;
  finalGitStatus: string;
  agents: PerAgentStat[];
  /** Phase 11c: exit contract snapshot at run end. Pass through if present. */
  contract?: ExitContract;
  // Unit 34: ambition-ratchet tier state, threaded through the build.
  maxTierReached?: number;
  tiersCompleted?: number;
  tierHistory?: RunSummary["tierHistory"];
  // Task #65: in-memory transcript snapshot at run-end.
  transcript?: import("../../types.js").TranscriptEntry[];
  /** Live apply/repair counters snapshot (optional; omit when no apply activity). */
  applyIntegrity?: RunSummary["applyIntegrity"];
  /** RR-D cycle fail taxonomy (optional). */
  cycleIntegrity?: RunSummary["cycleIntegrity"];
  /** RR-C research integrity (optional). */
  researchIntegrity?: RunSummary["researchIntegrity"];
  // V2 Step 3b.2: parallel-track V2 reducer state at run end.
  v2State?: RunSummary["v2State"];
  // V2 Step 5c.1: parallel-track V2 TodoQueue state at run end.
  v2QueueState?: RunSummary["v2QueueState"];
  // Phase 4a of #243: pass-through to RunSummary.topology.
  topology?: RunSummary["topology"];
  // Legacy phase fields (Phase 10: not populated for new runs).
  currentPhase?: RunSummary["currentPhase"];
  phases?: RunSummary["phases"];
  // R17 wiring (2026-05-04): structured errors collected during the
  // run. Empty array → RCA generates a degraded (but still useful)
  // report from timing + commit signals only. Populated → RCA gets
  // per-category counts and produces a sharper recommendation.
  errors?: readonly import("../errorTaxonomy.js").ClassifiedError[];
  /** Deliverables: files created or modified by this run. Derived from
   *  git porcelain output at summary time. When undefined, deliverables
   *  are extracted from `finalGitStatus` porcelain automatically. */
  deliverables?: Array<{ path: string; status: "created" | "modified" }>;
  /** Swarm control center advice emitted during the run (history hydrate). */
  controlAdvice?: import("@ollama-swarm/shared/swarmControl/controlAdvice").SwarmControlAdviceRecord[];
}

/**
 * Detect quota exhaustion in the terminal window: many 429/quota errors with
 * no successful agent turns. Surfaces as cap:quota instead of no-progress.
 */
