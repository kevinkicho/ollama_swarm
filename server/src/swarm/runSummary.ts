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

/** Build a stable per-run summary filename from the run's startedAt
 *  timestamp. Uses ISO-8601 with `:` and `.` swapped for `-` so the
 *  result is a legal Windows filename. Lexicographic sort matches
 *  chronological sort.
 *
 *  Example: startedAt 1776987725380 → "summary-2026-04-23T18-22-05-380Z.json".
 *
 *  Exported for tests and tooling that wants to know what file was
 *  written without re-deriving the rule.
 */
export function buildPerRunSummaryFileName(startedAt: number): string {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `summary-${iso}.json`;
}

/** Unit 50: find and read the newest prior summary in a clone, for the
 *  build-on-existing-clone resume path. Looks for files matching the
 *  Unit 49 per-run pattern (`summary-*.json`); the lex-sortable ISO
 *  filename means the alphabetically-last entry IS the chronologically-
 *  newest. Falls back to bare `summary.json` (latest pointer) if no
 *  per-run file exists — covers clones whose first run wrote summaries
 *  before Unit 49 shipped.
 *
 *  Returns null when no summary is on disk OR when the parsed JSON
 *  doesn't match the RunSummary shape we expect (defensive — a
 *  hand-edited summary.json shouldn't crash the planner). Best-effort:
 *  any I/O failure yields null, never throws.
 */
export async function findAndReadNewestPriorSummary(
  clonePath: string,
): Promise<RunSummary | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(clonePath);
  } catch {
    return null;
  }
  // Per-Unit-49 pattern matches AND the latest-pointer name. Lex sort
  // descending so summary-2026-04-23T18.json beats summary-2026-04-22.
  const perRunMatches = entries
    .filter((e) => /^summary-.+\.json$/.test(e))
    .sort()
    .reverse();
  // Try per-run files newest-first; if all are unparseable, fall back
  // to the latest pointer.
  const candidates = [...perRunMatches, "summary.json"];
  for (const name of candidates) {
    const abs = path.join(clonePath, name);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (looksLikeRunSummary(parsed)) {
      return parsed as RunSummary;
    }
  }
  return null;
}

// Conservative shape check: just enough to know we're not handing the
// planner garbage. Doesn't validate every optional field — those are
// blackboard-only and the regular RunSummary type already permits
// them missing for discussion presets.
function looksLikeRunSummary(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return (
    typeof obj.repoUrl === "string" &&
    typeof obj.startedAt === "number" &&
    typeof obj.endedAt === "number" &&
    typeof obj.preset === "string"
  );
}

/** Write a run summary to TWO files inside `<clonePath>`:
 *
 *   1. `summary-<isoStartedAt>.json` — per-run, never overwrites a
 *      sibling. Lets multiple runs against the same clone (the
 *      build-on-existing-clone work pattern from Units 47-51) leave a
 *      discoverable trail of summaries instead of clobbering each one.
 *
 *   2. `summary.json` — "latest" pointer that always reflects the most
 *      recent run. Existing tooling (scripts/compare-runs.mjs and the
 *      hand-written comparison files in runs/) keeps working unchanged.
 *
 *  Both writes are atomic (tmp-file + rename). The per-run write fires
 *  first so a crash between the two writes leaves at least the
 *  per-run record on disk. Returns both paths so callers can log
 *  exactly what was written.
 *
 *  Best-effort callers should wrap in try/catch — a write failure
 *  shouldn't crash the run. (Unit 48 ensures both filenames match the
 *  patterns excluded from `git status` via .git/info/exclude.)
 */
export async function writeRunSummary(
  clonePath: string,
  summary: RunSummary,
): Promise<{ perRunPath: string; latestPath: string }> {
  const json = JSON.stringify(summary, null, 2);
  const perRunPath = path.join(clonePath, buildPerRunSummaryFileName(summary.startedAt));
  const latestPath = path.join(clonePath, "summary.json");
  // Per-run first: if the second write fails, we still have a stable
  // per-run record. The "latest" pointer can be reconstructed by
  // reading the newest per-run file.
  await writeJsonAtomic(perRunPath, json);
  await writeJsonAtomic(latestPath, json);
  return { perRunPath, latestPath };
}
