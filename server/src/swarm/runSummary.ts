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
  TRANSCRIPT_MAX_ENTRIES,
  computeRunTokenTotals,
  type PerAgentStat,
  type RunSummary,
  type StopReason,
  type SummaryConfig,
} from "./blackboard/summary.js";
import type { TranscriptEntry } from "../types.js";

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
  /** When the runner detected a natural-stop signal mid-loop (e.g.
   *  judge confidence:high), pass the human-readable detail here. Sets
   *  stopReason="early-stop" + stopDetail=<this string>. Ignored if
   *  crashMessage or stopping take precedence. */
  earlyStopDetail?: string;
  filesChanged: number;
  finalGitStatus: string;
  agents: PerAgentStat[];
  // Task #65: in-memory transcript snapshot at run-end. The runner
  // owns this.transcript and just hands a copy in here. Optional —
  // older callers that haven't been updated yet still produce valid
  // summaries (just without transcript replay).
  transcript?: TranscriptEntry[];
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

  // Task #65: cap transcript at TRANSCRIPT_MAX_ENTRIES (head, not
  // tail — the early system + setup entries are usually the most
  // useful for review). Mark truncation so the modal can surface it.
  let transcript: TranscriptEntry[] | undefined;
  let transcriptTruncated: boolean | undefined;
  if (input.transcript && input.transcript.length > 0) {
    if (input.transcript.length > TRANSCRIPT_MAX_ENTRIES) {
      transcript = input.transcript.slice(0, TRANSCRIPT_MAX_ENTRIES);
      transcriptTruncated = true;
    } else {
      transcript = input.transcript.slice();
    }
  }

  // Task #154: discussion presets (council, role-diff, OW, OW-deep,
  // debate-judge default, map-reduce, stigmergy) do not write files.
  // input.filesChanged comes from `git status` on the clone, which
  // reflects ANY dirty state — including uncommitted changes from
  // prior blackboard runs on the same clone. Reporting that as
  // "files changed by this run" is misleading. Set to 0 for discussion
  // presets unconditionally. (The one exception is debate-judge with
  // executeNextAction=true, which CAN run an implementer turn that
  // writes files. We don't separately track per-run commits in the
  // discussion summary path today, so this is also reported as 0 in
  // that mode — accurate per-run tracking would require a git-HEAD
  // diff against run-start, deferred as a separate task.)
  const filesChangedByThisRun = 0;
  // Task #163: run-level token totals via the same helper blackboard uses.
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
    // Blackboard-only fields intentionally omitted. Comparison tooling
    // checks `preset` to know what's applicable.
    filesChanged: filesChangedByThisRun,
    finalGitStatus,
    finalGitStatusTruncated: truncated,
    totalPromptTokens,
    totalResponseTokens,
    agents: input.agents.slice(),
    transcript,
    transcriptTruncated,
  };
}

function classifyDiscussionStopReason(
  input: Pick<DiscussionSummaryInput, "crashMessage" | "stopping" | "earlyStopDetail">,
): { stopReason: StopReason; stopDetail?: string } {
  if (input.crashMessage) {
    return { stopReason: "crash", stopDetail: input.crashMessage };
  }
  if (input.stopping) {
    return { stopReason: "user" };
  }
  if (input.earlyStopDetail) {
    return { stopReason: "early-stop", stopDetail: input.earlyStopDetail };
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

// Task #68 (2026-04-24): rich end-of-run banner appended to the
// transcript so users see a clear "run finished" marker AND a
// per-agent stats summary at the very end. Used by every runner's
// writeSummary path. Format favors readability over compactness:
// full field names, all metrics shown (even zeros), one line per
// agent with its role.
function fmtRuntime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Mirror of the web-side roleForRow / agentRole helpers — kept
// server-side too so the banner shows readable role names instead
// of bare indices. Preset-specific.
function roleForAgent(preset: string, idx: number, totalAgents: number): string {
  switch (preset) {
    case "blackboard":
      if (idx === 1) return "planner";
      if (idx > totalAgents - 1) return "auditor";
      return "worker";
    case "orchestrator-worker":
      return idx === 1 ? "orchestrator" : "worker";
    case "orchestrator-worker-deep": {
      // Task #131: 3 tiers — orchestrator (idx 1), then K mid-leads,
      // then workers. K = max(1, ceil((totalAgents-1)/6)) — kept in
      // sync with computeDeepTopology in OrchestratorWorkerDeepRunner.
      if (idx === 1) return "orchestrator";
      const remaining = Math.max(0, totalAgents - 1);
      const targetK = Math.max(1, Math.ceil(remaining / 6));
      const maxK = Math.max(1, Math.floor(remaining / 3));
      const k = Math.min(targetK, maxK);
      return idx <= 1 + k ? "mid-lead" : "worker";
    }
    case "map-reduce":
      return idx === 1 ? "reducer" : "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      if (idx === 1) return "pro";
      if (idx === 2) return "con";
      if (idx === 3) return "judge";
      return "peer";
    default:
      return idx === 1 ? "planner" : "worker";
  }
}

export function formatRunFinishedBanner(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`═══ Run finished — ${summary.stopReason} in ${fmtRuntime(summary.wallClockMs)} ═══`);

  // Top-level totals. Always show the core 3 (files, commits, lines);
  // todo counters only when applicable (blackboard).
  let added = 0;
  let removed = 0;
  for (const a of summary.agents) {
    added += a.linesAdded ?? 0;
    removed += a.linesRemoved ?? 0;
  }
  const commitsTotal = summary.commits ?? 0;
  lines.push(
    `Files changed: ${summary.filesChanged} · ` +
      `Commits: ${commitsTotal} · ` +
      `Lines: +${added} / -${removed}`,
  );
  if (summary.stopDetail) {
    lines.push(`Stop detail: ${summary.stopDetail}`);
  }
  if (summary.totalTodos !== undefined && summary.totalTodos > 0) {
    lines.push(
      `Todos: ${summary.totalTodos} total · ${commitsTotal} committed · ` +
        `${summary.skippedTodos ?? 0} skipped · ${summary.staleEvents ?? 0} stale events`,
    );
  }

  // Per-agent rollup. One line per agent, full field names, ALL
  // counters shown (even zeros) so the format is predictable. For
  // discussion presets the commits/lines/rejected/etc. all read 0
  // honestly rather than being silently omitted.
  if (summary.agents.length > 0) {
    lines.push("");
    lines.push(`Per-agent breakdown (${summary.agents.length} agents):`);
    const N = summary.agents.length;
    for (const a of summary.agents) {
      const role = roleForAgent(summary.preset, a.agentIndex, N);
      const turns = a.turnsTaken;
      const attempts = a.totalAttempts ?? turns;
      const retries = a.totalRetries ?? 0;
      const mean = fmtMs(a.meanLatencyMs);
      const commits = a.commits ?? 0;
      const linesAdded = a.linesAdded ?? 0;
      const linesRemoved = a.linesRemoved ?? 0;
      const rejected = a.rejectedAttempts ?? 0;
      const jsonRepairs = a.jsonRepairs ?? 0;
      const errors = a.promptErrors ?? 0;
      lines.push(
        `  agent-${a.agentIndex} (${role}): ${turns} turns · ${attempts} attempts · ${retries} retries · mean ${mean}`,
      );
      lines.push(
        `              ${commits} commits · +${linesAdded} / -${linesRemoved} lines · ` +
          `${rejected} rejected · ${jsonRepairs} JSON-repairs · ${errors} errors`,
      );
    }
  }
  return lines.join("\n");
}

// Task #68: format the kill-verification line. Called by every runner
// right after manager.killAll() at end-of-run so users see explicit
// confirmation that all agent ports were released.
export function formatPortReleaseLine(killResult: { total: number; escaped: number }): string {
  if (killResult.escaped === 0) {
    return `✓ All ${killResult.total} agent port${killResult.total === 1 ? "" : "s"} released cleanly.`;
  }
  return `⚠ ${killResult.escaped} of ${killResult.total} agent process(es) escaped the kill — orphan sweep will catch them at next start.`;
}

// Task #72 (2026-04-25): build the structured TranscriptEntrySummary
// for the run-finished banner. The web Transcript component renders
// this as a grid (per-agent table) instead of parsing the plain-text
// banner. Runner attaches both — text for legacy clients, summary
// for the grid renderer.
import type { TranscriptEntrySummary } from "../types.js";
export function buildRunFinishedSummary(summary: RunSummary): TranscriptEntrySummary {
  let added = 0;
  let removed = 0;
  for (const a of summary.agents) {
    added += a.linesAdded ?? 0;
    removed += a.linesRemoved ?? 0;
  }
  const N = summary.agents.length;
  return {
    kind: "run_finished",
    runId: summary.runId,
    preset: summary.preset,
    model: summary.model,
    repoUrl: summary.repoUrl,
    clonePath: summary.localPath,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    stopReason: summary.stopReason,
    stopDetail: summary.stopDetail,
    wallClockMs: summary.wallClockMs,
    filesChanged: summary.filesChanged,
    commits: summary.commits,
    totalTodos: summary.totalTodos,
    skippedTodos: summary.skippedTodos,
    staleEvents: summary.staleEvents,
    linesAdded: added,
    linesRemoved: removed,
    // Task #163: forward run-level token totals from the summary.
    totalPromptTokens: summary.totalPromptTokens,
    totalResponseTokens: summary.totalResponseTokens,
    agents: summary.agents.map((a) => ({
      agentIndex: a.agentIndex,
      role: roleForAgent(summary.preset, a.agentIndex, N),
      turns: a.turnsTaken,
      attempts: a.totalAttempts ?? a.turnsTaken,
      retries: a.totalRetries ?? 0,
      meanLatencyMs: a.meanLatencyMs ?? null,
      commits: a.commits ?? 0,
      linesAdded: a.linesAdded ?? 0,
      linesRemoved: a.linesRemoved ?? 0,
      rejected: a.rejectedAttempts ?? 0,
      jsonRepairs: a.jsonRepairs ?? 0,
      promptErrors: a.promptErrors ?? 0,
      // Task #163: per-agent token totals.
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
    })),
  };
}

// Task #72: structured payload for the seed-announce system message
// (Project clone / Repo / Top-level entries). Web renders as a
// definition list + collapsible file grid.
export function buildSeedSummary(
  repoUrl: string,
  clonePath: string,
  topLevel: readonly string[],
): TranscriptEntrySummary {
  return {
    kind: "seed_announce",
    repoUrl,
    clonePath,
    topLevel: [...topLevel],
  };
}
