// Phase 9: per-run summary artifact. Pure shape-assembly function so the
// runner side stays testable. The runner collects counters + git status
// strings and hands them here; this module classifies the stop reason,
// computes wall-clock, and returns a JSON-serializable object that gets
// written to `<clone>/summary.json` and broadcast over WS.
//
// stopReason discriminator priority (same as caps.ts — first match wins):
//   1. crashMessage set            → "crash"
//   2. terminationReason set       → "cap:<type>" (wall-clock | commits | todos)
//   3. stopping flag set (no cap)  → "user"
//   4. else                        → "completed" (with optional completionDetail
//                                    e.g. "all contract criteria satisfied" or
//                                    "auditor cap reached")
//
// finalGitStatus is capped at FINAL_GIT_STATUS_MAX chars so a pathological
// git state (thousands of untracked files) can't blow out the artifact.

import type { ExitContract } from "./types.js";
import { tokenTracker as tokenTrackerSingleton } from "../../services/ollamaProxy.js";

export const FINAL_GIT_STATUS_MAX = 4_000;
// Task #65: transcript persistence cap. Typical discussion runs land
// 10-100 entries; blackboard can hit 200-500. 1000 is comfortable
// headroom; runs beyond it set transcriptTruncated=true and keep the
// FIRST 1000 (head, not tail — the early system + setup entries are
// usually the most useful for review).
export const TRANSCRIPT_MAX_ENTRIES = 1_000;

export type StopReason =
  | "completed"
  | "user"
  | "crash"
  | "cap:wall-clock"
  | "cap:commits"
  | "cap:todos"
  | "cap:tokens"
  | "cap:quota"
  | "early-stop";

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
    startedAt: number;
    endedAt: number;
  }>;
  // V2 Step 3b.2: end-of-run snapshot of the parallel V2 reducer state
  // + accumulated divergences across the run. Blackboard-only. Allows
  // post-run inspection of whether the V2 model agreed with V1 phase
  // transitions (zero divergences = promotion-ready). Optional for
  // back-compat with summaries written before this field landed.
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
  // V2 Step 5c.1: end-of-run snapshot of the parallel V2 TodoQueue
  // mirror + per-event divergences vs V1 board.counts(). Zero
  // divergences = the V2 queue tracked V1 perfectly; promotion-ready.
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

export interface SummaryConfig {
  repoUrl: string;
  localPath: string;
  preset: string;
  model: string;
  /** Task #36: runId threaded from cfg.runId so buildSummary can include
   *  it in the RunSummary output. Optional — builders that don't know
   *  it (tests, older call paths) just omit it. */
  runId?: string;
}

export interface SummaryCounts {
  committed: number;
  skipped: number;
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
  /** True if user pressed Stop (or a cap flipped the flag). Distinguished via
   *  terminationReason: user stops leave it unset, cap stops set it. */
  stopping: boolean;
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
  // V2 Step 3b.2: parallel-track V2 reducer state at run end.
  v2State?: RunSummary["v2State"];
  // V2 Step 5c.1: parallel-track V2 TodoQueue state at run end.
  v2QueueState?: RunSummary["v2QueueState"];
}

export function buildSummary(input: BuildSummaryInput): RunSummary {
  const wallClockMs = Math.max(0, input.endedAt - input.startedAt);
  const { stopReason, stopDetail } = classifyStopReason(input);

  let finalGitStatus = input.finalGitStatus;
  let truncated = false;
  if (finalGitStatus.length > FINAL_GIT_STATUS_MAX) {
    finalGitStatus = finalGitStatus.slice(0, FINAL_GIT_STATUS_MAX);
    truncated = true;
  }

  // Task #163: accurate run-level token totals via tokenTracker.recent
  // filtered by ts in the run window. Independent of per-agent fields
  // (which are approximate for parallel paths).
  const { totalPromptTokens, totalResponseTokens } = computeRunTokenTotals(
    input.startedAt,
    input.endedAt,
  );

  return {
    runId: input.config.runId,
    repoUrl: input.config.repoUrl,
    localPath: input.config.localPath,
    preset: input.config.preset,
    model: input.config.model,
    agentCount: input.agentCount,
    rounds: input.rounds,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    wallClockMs,
    stopReason,
    stopDetail,
    commits: input.board.committed,
    staleEvents: input.staleEvents,
    skippedTodos: input.board.skipped,
    totalTodos: input.board.total,
    filesChanged: input.filesChanged,
    finalGitStatus,
    finalGitStatusTruncated: truncated,
    totalPromptTokens,
    totalResponseTokens,
    agents: input.agents.slice(),
    contract: input.contract ? cloneContract(input.contract) : undefined,
    // Task #65: cap transcript at TRANSCRIPT_MAX_ENTRIES (head) so a
    // pathological run doesn't blow the summary file. transcriptTruncated
    // surfaces in the modal for honesty.
    ...(() => {
      const t = input.transcript;
      if (!t || t.length === 0) return {};
      if (t.length > TRANSCRIPT_MAX_ENTRIES) {
        return { transcript: t.slice(0, TRANSCRIPT_MAX_ENTRIES), transcriptTruncated: true };
      }
      return { transcript: t.slice() };
    })(),
    // Unit 34: ambition ratchet passthrough.
    maxTierReached: input.maxTierReached,
    tiersCompleted: input.tiersCompleted,
    tierHistory: input.tierHistory ? input.tierHistory.map((t) => ({ ...t })) : undefined,
    // V2 Step 3b.2: parallel-track reducer state passthrough.
    v2State: input.v2State,
    // V2 Step 5c.1: parallel-track TodoQueue state passthrough.
    v2QueueState: input.v2QueueState,
  };
}

function cloneContract(c: ExitContract): ExitContract {
  return {
    missionStatement: c.missionStatement,
    criteria: c.criteria.map((crit) => ({
      ...crit,
      expectedFiles: [...crit.expectedFiles],
    })),
  };
}

function classifyStopReason(
  input: Pick<
    BuildSummaryInput,
    "crashMessage" | "terminationReason" | "stopping" | "completionDetail"
  >,
): { stopReason: StopReason; stopDetail?: string } {
  if (input.crashMessage) {
    return { stopReason: "crash", stopDetail: input.crashMessage };
  }
  if (input.terminationReason) {
    const capType = parseCapType(input.terminationReason);
    return { stopReason: capType, stopDetail: input.terminationReason };
  }
  if (input.stopping) {
    return { stopReason: "user" };
  }
  return { stopReason: "completed", stopDetail: input.completionDetail };
}

// Unit 21: small pure helper for per-agent latency stats. Returns
// p50/p95/mean over the given samples or null when empty (so the
// summary doesn't lie about an agent that never produced a successful
// attempt). Sort is non-mutating.
export interface LatencyStats {
  mean: number | null;
  p50: number | null;
  p95: number | null;
}
export function computeLatencyStats(samplesMs: readonly number[]): LatencyStats {
  if (samplesMs.length === 0) return { mean: null, p50: null, p95: null };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  // Nearest-rank percentile: ceil(p * N / 100) - 1, clamped to [0, N-1].
  const at = (p: number): number => {
    const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
    return sorted[rank - 1];
  };
  return {
    mean: Math.round(sum / sorted.length),
    p50: at(50),
    p95: at(95),
  };
}

// Task #163: scan tokenTracker.recent[] for records timestamped within
// the run window (startedAt → endedAt + 5s grace for proxy-side capture
// latency). Returns 0/0 when the proxy isn't running or no records
// land in the window. Optional `tracker` arg for tests; defaults to
// the module-level singleton.
export function computeRunTokenTotals(
  startedAt: number,
  endedAt: number,
  tracker?: { recent: (n: number) => ReadonlyArray<{ ts: number; promptTokens: number; responseTokens: number }> },
): { totalPromptTokens: number; totalResponseTokens: number } {
  const t = tracker ?? tokenTrackerSingleton;
  const grace = 5_000;
  const lo = startedAt;
  const hi = endedAt + grace;
  // Pull a generous slice — up to 10k records — and filter by window.
  // The tracker caps at 100k; for any reasonable single-run duration
  // this slice is plenty.
  const recent = t.recent(10_000);
  let p = 0, r = 0;
  for (const rec of recent) {
    if (rec.ts < lo || rec.ts > hi) continue;
    p += rec.promptTokens;
    r += rec.responseTokens;
  }
  return { totalPromptTokens: p, totalResponseTokens: r };
}

function parseCapType(reason: string): StopReason {
  // Keep in sync with caps.ts reason strings. Anything unrecognized gets
  // bucketed as wall-clock since that's the original cap and least wrong.
  if (reason.startsWith("wall-clock cap")) return "cap:wall-clock";
  if (reason.startsWith("commits cap")) return "cap:commits";
  if (reason.startsWith("todos cap")) return "cap:todos";
  if (reason.startsWith("token-budget")) return "cap:tokens";
  // Task #158: #137's quota-wall reason ("ollama-quota-exhausted (NNN: ...)")
  // was previously falling through to cap:wall-clock — misleading. Surface
  // it as its own bucket so summaries / UI can color it distinctly.
  if (reason.startsWith("ollama-quota-exhausted")) return "cap:quota";
  return "cap:wall-clock";
}
