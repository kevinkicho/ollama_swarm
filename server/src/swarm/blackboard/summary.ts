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

export const FINAL_GIT_STATUS_MAX = 4_000;

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
  /** Phase 11c: the exit contract as it stood at run end, including per-criterion
   *  verdicts applied by the auditor. Undefined when the first-pass contract
   *  prompt failed to parse and the run fell back to drain-exit. */
  contract?: ExitContract;
}

export interface SummaryConfig {
  repoUrl: string;
  localPath: string;
  preset: string;
  model: string;
}

export interface SummaryCounts {
  committed: number;
  skipped: number;
  total: number;
}

export interface BuildSummaryInput {
  config: SummaryConfig;
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

  return {
    repoUrl: input.config.repoUrl,
    localPath: input.config.localPath,
    preset: input.config.preset,
    model: input.config.model,
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
    agents: input.agents.slice(),
    contract: input.contract ? cloneContract(input.contract) : undefined,
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

function parseCapType(reason: string): StopReason {
  // Keep in sync with caps.ts reason strings. Anything unrecognized gets
  // bucketed as wall-clock since that's the original cap and least wrong.
  if (reason.startsWith("wall-clock cap")) return "cap:wall-clock";
  if (reason.startsWith("commits cap")) return "cap:commits";
  if (reason.startsWith("todos cap")) return "cap:todos";
  return "cap:wall-clock";
}
