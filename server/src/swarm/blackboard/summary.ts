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
//   4. else                        → "completed"
//
// finalGitStatus is capped at FINAL_GIT_STATUS_MAX chars so a pathological
// git state (thousands of untracked files) can't blow out the artifact.

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
  board: SummaryCounts;
  staleEvents: number;
  filesChanged: number;
  finalGitStatus: string;
  agents: PerAgentStat[];
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
  };
}

function classifyStopReason(
  input: Pick<BuildSummaryInput, "crashMessage" | "terminationReason" | "stopping">,
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
  return { stopReason: "completed" };
}

function parseCapType(reason: string): StopReason {
  // Keep in sync with caps.ts reason strings. Anything unrecognized gets
  // bucketed as wall-clock since that's the original cap and least wrong.
  if (reason.startsWith("wall-clock cap")) return "cap:wall-clock";
  if (reason.startsWith("commits cap")) return "cap:commits";
  if (reason.startsWith("todos cap")) return "cap:todos";
  return "cap:wall-clock";
}
