// Unit 33: cross-preset summary helpers.
//
// Until this unit, only blackboard wrote `<clone>/summary.json` at run
// end — every other preset left nothing on disk to compare runs by. This
// module fills that gap with two pieces:
//
//   1. `buildDiscussionSummary` — produces the shared `RunSummary` shape
//      for non-blackboard (discussion-only) runners. Same schema as
//      blackboard's summary, with the blackboard-only fields (commits /
//      staleEvents / skippedTodos / totalTodos / contract) simply left
//      absent. Stop-reason classification matches blackboard's for the
//      three reasons non-blackboard presets can hit today (completed /
//      user / crash); blackboard keeps its cap:* variants via the
//      existing `buildSummary`.
//
//   2. `writeRunSummary` — the shared I/O. Writes to
//      `<clonePath>/summary.json` atomically so a partial write never
//      leaves a torn file. Same location every runner uses, so the
//      comparison script (scripts/compare-runs.mjs) can glob without
//      caring which preset produced the file.

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  FINAL_GIT_STATUS_MAX,
  type PerAgentStat,
  type RunSummary,
  type StopReason,
  type SummaryConfig,
} from "./blackboard/summary.js";

export interface DiscussionSummaryInput {
  config: SummaryConfig;
  agentCount: number;
  rounds: number;
  startedAt: number;
  endedAt: number;
  /** Non-null when the run threw. Takes precedence over every other
   *  stop reason. */
  crashMessage?: string;
  /** True if user pressed Stop. Ignored when `crashMessage` is set. */
  stopping: boolean;
  filesChanged: number;
  finalGitStatus: string;
  agents: PerAgentStat[];
}

export function buildDiscussionSummary(input: DiscussionSummaryInput): RunSummary {
  const wallClockMs = Math.max(0, input.endedAt - input.startedAt);
  const { stopReason, stopDetail } = classifyDiscussionStopReason(input);

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
    agentCount: input.agentCount,
    rounds: input.rounds,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    wallClockMs,
    stopReason,
    stopDetail,
    // Blackboard-only fields intentionally omitted. Comparison tooling
    // checks `preset` to know what's applicable.
    filesChanged: input.filesChanged,
    finalGitStatus,
    finalGitStatusTruncated: truncated,
    agents: input.agents.slice(),
  };
}

function classifyDiscussionStopReason(
  input: Pick<DiscussionSummaryInput, "crashMessage" | "stopping">,
): { stopReason: StopReason; stopDetail?: string } {
  if (input.crashMessage) {
    return { stopReason: "crash", stopDetail: input.crashMessage };
  }
  if (input.stopping) {
    return { stopReason: "user" };
  }
  return { stopReason: "completed" };
}

// Tmp-file + rename so a crash mid-write leaves any prior summary
// intact. fs.rename replaces atomically on both POSIX and Windows. This
// mirrors blackboard's writeFileAtomic but lives at the cross-preset
// layer so non-blackboard runners don't reach into blackboard/.
async function writeJsonAtomic(abs: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.run-summary-tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Write a run summary to `<clonePath>/summary.json`. Atomic (tmp-file +
 *  rename) so a crash mid-write doesn't leave a torn file. Returns the
 *  absolute path the summary was written to. Best-effort callers
 *  should wrap in try/catch — a write failure shouldn't crash the run.
 */
export async function writeRunSummary(
  clonePath: string,
  summary: RunSummary,
): Promise<string> {
  const outPath = path.join(clonePath, "summary.json");
  await writeJsonAtomic(outPath, JSON.stringify(summary, null, 2));
  return outPath;
}
