// 2026-05-03 (Phase C of shared-layer refactor): the writeSummary
// method 8 discussion runners had near-identically copied. Pre-extraction
// state (the audit's Pattern 1):
//   - 7 runners: byte-identical body — `summaryWritten` guard + early
//     return on missing startedAt + best-effort gitStatus + call to
//     buildDiscussionSummary + writeRunSummary + banner emission +
//     terse log line
//   - MoaRunner: same shape but with 4 divergences — `actualRoundsCompleted`
//     overrides cfg.rounds, agents=[] (no AgentStatsCollector), no
//     earlyStopDetail, no banner, log line omits files
//
// The helper takes opts that cover all 4 MoA divergences as parameters
// with sensible defaults. Each runner's writeSummary collapses from
// ~40 lines to ~10 wrapping discussionWriteSummary().
//
// CALLER STILL OWNS: the `summaryWritten` guard + private startedAt
// check, because both touch private fields. Helper takes startedAt
// as a non-undefined arg so callers handle that branch themselves.

import {
  buildDiscussionSummary,
  type DiscussionSummaryInput,
} from "./runSummary.js";
import {
  buildRunFinishedSummary,
  formatRunFinishedBanner,
  writeRunSummary,
} from "./runSummary.js";
import type { PerAgentStat, RunSummary } from "./blackboard/summary.js";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { RepoService } from "../services/RepoService.js";
import type { RunConfig } from "./SwarmRunner.js";
import { resolveRunGitMetrics } from "./blackboard/gitRunDelta.js";

export interface DiscussionWriteSummaryOpts {
  cfg: RunConfig;
  /** Non-null when the run threw. Takes precedence over every other
   *  stop reason. */
  crashMessage?: string;
  /** True if user pressed Stop. Ignored when crashMessage is set. */
  stopping: boolean;
  /** Run-start timestamp. Helper assumes it's already set — callers
   *  guard the `startedAt === undefined` branch themselves. */
  startedAt: number;
  /** Run-end timestamp. Defaults to Date.now() when omitted. */
  endedAt?: number;
  /** Optional natural-stop detail (e.g. "judge-confidence-high after
   *  round 2/4"). Only Council/Debate/MR/OW/OW-Deep/RR/Stigmergy use
   *  this — MoA omits it. */
  earlyStopDetail?: string;
  /** Override for cfg.rounds — MoA passes `actualRoundsCompleted`
   *  here, others omit (uses cfg.rounds). */
  rounds?: number;
  agentCount: number;
  /** Per-agent stats. MoA passes `[]` (no AgentStatsCollector). */
  agents: PerAgentStat[];
  transcript: TranscriptEntry[];
  /** Phase 4a of #243: topology passthrough so summary.json carries
   *  exact agent specs. */
  topology?: RunSummary["topology"];

  /** Repo service for the gitStatus call. */
  repos: RepoService;
  /** When set, git summary fields are scoped to this run (not whole-clone dirt). */
  gitPorcelainAtRunStart?: string;
  /** Runner's appendSystem method. Used to emit the banner + the
   *  terse log line. */
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;

  /** Whether to emit the rich `formatRunFinishedBanner` + structured
   *  `buildRunFinishedSummary`. Default true. MoA passes false (it
   *  doesn't track per-agent stats so the banner would render empty). */
  emitBanner?: boolean;
  /** Whether the terse log line includes `, files=${n}`. Default true.
   *  MoA passes false. */
  includeFilesInLogLine?: boolean;
  controlAdvice?: RunSummary["controlAdvice"];
}

/** The shared writeSummary body. Calling pattern in each runner:
 *
 *      private async writeSummary(cfg: RunConfig, crashMessage?: string) {
 *        if (this.summaryWritten) return;
 *        this.summaryWritten = true;
 *        if (this.startedAt === undefined) return;
 *        await discussionWriteSummary({
 *          cfg, crashMessage, stopping: this.stopping,
 *          startedAt: this.startedAt, earlyStopDetail: this.earlyStopDetail,
 *          agentCount: cfg.agentCount, agents: this.stats.buildPerAgentStats(),
 *          transcript: this.transcript, topology: cfg.topology,
 *          repos: this.opts.repos, appendSystem: (t, s) => this.appendSystem(t, s),
 *        });
 *      }
 */
export async function discussionWriteSummary(opts: DiscussionWriteSummaryOpts): Promise<void> {
  let gitStatus = { porcelain: "", changedFiles: 0 };
  try {
    gitStatus = await opts.repos.gitStatus(opts.cfg.localPath);
  } catch {
    // best-effort — git status failure shouldn't block the summary
  }

  const runGit = opts.gitPorcelainAtRunStart !== undefined
    ? await resolveRunGitMetrics(opts.cfg.localPath, {
        baselinePorcelain: opts.gitPorcelainAtRunStart,
        endPorcelain: gitStatus.porcelain,
        runStartedAt: opts.startedAt,
      })
    : { filesChanged: 0, finalGitStatus: "", deliverables: undefined };

  const summaryInput: DiscussionSummaryInput = {
    config: {
      repoUrl: opts.cfg.repoUrl,
      localPath: opts.cfg.localPath,
      preset: opts.cfg.preset,
      model: opts.cfg.model,
      runId: opts.cfg.runId,
    },
    agentCount: opts.agentCount,
    rounds: opts.rounds ?? opts.cfg.rounds,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt ?? Date.now(),
    crashMessage: opts.crashMessage,
    stopping: opts.stopping,
    earlyStopDetail: opts.earlyStopDetail,
    filesChanged: runGit.filesChanged,
    finalGitStatus: runGit.finalGitStatus,
    agents: opts.agents,
    transcript: opts.transcript,
    topology: opts.topology,
    controlAdvice: opts.controlAdvice,
  };
  const summary = buildDiscussionSummary(summaryInput);

  try {
    await writeRunSummary(opts.cfg.localPath, summary);
    // Task #68: rich end-of-run banner with per-agent rollup. Posted
    // BEFORE the terse file-write line so the most informative content
    // is the last thing the user reads. Task #72: also attach the
    // structured summary so the web renders a grid.
    if (opts.emitBanner !== false) {
      opts.appendSystem(
        formatRunFinishedBanner(summary),
        buildRunFinishedSummary(summary),
      );
    }
    const filesSuffix =
      opts.includeFilesInLogLine !== false
        ? `, files=${summary.filesChanged}`
        : "";
    opts.appendSystem(
      `Wrote run summary (stopReason=${summary.stopReason}, wallClockMs=${summary.wallClockMs}${filesSuffix}).`,
    );
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    opts.appendSystem(`Failed to write run summary (${msg})`);
  }
}
