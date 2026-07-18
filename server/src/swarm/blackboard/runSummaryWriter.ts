// Extracted from BlackboardRunner.ts — writeRunSummary and buildPerAgentStats.
// Takes narrow context objects instead of referencing `this.*`.

import path from "node:path";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract, Todo } from "./types.js";
import type { TranscriptEntry, TranscriptEntrySummary, SwarmEvent } from "../../types.js";
import type { PerAgentStat, RunSummary } from "./summary.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { RunStateObserver } from "./RunStateObserver.js";
import { computeLatencyStats } from "./summary.js";
import { buildPerRunSummaryFileName, buildRunFinishedSummary, formatRunFinishedBanner } from "../runSummary.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { buildSummary } from "./summary.js";
import { resolveRunGitMetrics } from "./gitRunDelta.js";
import { config } from "../../config.js";
import { snapshotApplyIntegrityForRun } from "../applyIntegrityStats.js";
import { snapshotCycleIntegrityForRun } from "../cycleIntegrityStats.js";
import { snapshotResearchIntegrity } from "../research/researchBudget.js";

export interface PerAgentCounters {
  agentRoster: Array<{ id: string; index: number }>;
  turnsPerAgent: Map<string, number>;
  promptTokensPerAgent: Map<string, number>;
  responseTokensPerAgent: Map<string, number>;
  attemptsPerAgent: Map<string, number>;
  retriesPerAgent: Map<string, number>;
  latenciesPerAgent: Map<string, number[]>;
  commitsPerAgent: Map<string, number>;
  linesAddedPerAgent: Map<string, number>;
  linesRemovedPerAgent: Map<string, number>;
  rejectedAttemptsPerAgent: Map<string, number>;
  jsonRepairsPerAgent: Map<string, number>;
  promptErrorsPerAgent: Map<string, number>;
}

export function buildPerAgentStats(counters: PerAgentCounters): PerAgentStat[] {
  return counters.agentRoster.map((a) => {
    const lats = counters.latenciesPerAgent.get(a.id) ?? [];
    const stats = computeLatencyStats(lats);
    return {
      agentId: a.id,
      agentIndex: a.index,
      turnsTaken: counters.turnsPerAgent.get(a.id) ?? 0,
      tokensIn: counters.promptTokensPerAgent.has(a.id) ? counters.promptTokensPerAgent.get(a.id)! : null,
      tokensOut: counters.responseTokensPerAgent.has(a.id) ? counters.responseTokensPerAgent.get(a.id)! : null,
      totalAttempts: counters.attemptsPerAgent.get(a.id) ?? 0,
      totalRetries: counters.retriesPerAgent.get(a.id) ?? 0,
      successfulAttempts: lats.length,
      meanLatencyMs: stats.mean,
      p50LatencyMs: stats.p50,
      p95LatencyMs: stats.p95,
      commits: counters.commitsPerAgent.get(a.id) ?? 0,
      linesAdded: counters.linesAddedPerAgent.get(a.id) ?? 0,
      linesRemoved: counters.linesRemovedPerAgent.get(a.id) ?? 0,
      rejectedAttempts: counters.rejectedAttemptsPerAgent.get(a.id) ?? 0,
      jsonRepairs: counters.jsonRepairsPerAgent.get(a.id) ?? 0,
      promptErrors: counters.promptErrorsPerAgent.get(a.id) ?? 0,
    };
  });
}

export interface SummaryContext {
  cfg: RunConfig;
  runBootedAt: number;
  /** Porcelain snapshot after clone setup; scopes git summary fields to this run. */
  gitPorcelainAtRunStart: string;
  runStartedAt: number | undefined;
  tickAccumulatorActiveElapsedMs: number | undefined;
  stopping: boolean;
  userStopRequested?: boolean;
  wasDrained?: boolean;
  getLastSummary?: () => RunSummary | undefined;
  crashMessage: string | undefined;
  terminationReason: string | undefined;
  completionDetail: string | undefined;
  staleEventCount: number;
  auditInvocations: number;
  currentTier: number;
  tiersCompleted: number;
  tierHistory: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
    wallClockMs: number;
    wastedWallClockMs: number;
    startedAt: number;
    endedAt: number;
  }>;
  contract: ExitContract | undefined;
  transcript: TranscriptEntry[];
  agentStats: PerAgentStat[];
  boardCounts: { committed: number; skipped: number; stale: number; total: number };
  gitStatus: { porcelain: string; changedFiles: number };
  errorTracker: ClassifiedError[];
  controlAdvice?: import("@ollama-swarm/shared/swarmControl/controlAdvice").SwarmControlAdviceRecord[];
  v2State: { phase: string; enteredAt: number; detail?: string; pausedReason?: string };
  v2QueueState: { counts: ReturnType<TodoQueue["counts"]> };
  cloneContract: (c: ExitContract) => ExitContract;
  lastSummarySetter: (s: RunSummary) => void;
  emit: (event: SwarmEvent) => void;
  appendSystem: (msg: string, summary?: TranscriptEntrySummary) => void;
}

export async function writeRunSummary(ctx: SummaryContext): Promise<void> {
  const { cfg } = ctx;
  if (ctx.runBootedAt === undefined) return;

  const runGit = await resolveRunGitMetrics(cfg.localPath, {
    baselinePorcelain: ctx.gitPorcelainAtRunStart,
    endPorcelain: ctx.gitStatus.porcelain,
    commitCount: ctx.boardCounts.committed,
    runStartedAt: ctx.runStartedAt ?? ctx.runBootedAt,
  });

  let summary = buildSummary({
    config: {
      repoUrl: cfg.repoUrl,
      localPath: cfg.localPath,
      preset: cfg.preset,
      model: cfg.model,
      runId: cfg.runId,
      startCommand: [
        "curl -X POST /api/swarm/start",
        `-H 'Content-Type: application/json'`,
        `-d '${JSON.stringify({
          preset: cfg.preset,
          model: cfg.model,
          agentCount: cfg.agentCount,
          rounds: cfg.rounds,
          plannerModel: cfg.plannerModel,
          workerModel: cfg.workerModel,
          auditorModel: cfg.auditorModel,
          dedicatedAuditor: cfg.dedicatedAuditor,
          userDirective: cfg.userDirective,
          plannerTools: cfg.plannerTools,
          webTools: cfg.webTools,
          specializedWorkers: cfg.specializedWorkers,
          criticEnsemble: cfg.criticEnsemble,
        }, null, 2)}'`,
      ].join(" \\\n  "),
      userDirective: cfg.userDirective,
      plannerTools: cfg.plannerTools,
      webTools: cfg.webTools,
    },
    // Phase 10: no currentPhase/phases forwarded (emitters removed).
    agentCount: cfg.agentCount,
    rounds: cfg.rounds,
    startedAt: ctx.runBootedAt,
    endedAt: Date.now(),
    crashMessage: ctx.crashMessage,
    terminationReason: ctx.terminationReason,
    stopping: ctx.stopping,
    userStopRequested: ctx.userStopRequested,
    wasDrained: ctx.wasDrained,
    completionDetail: ctx.completionDetail,
    board: {
      committed: ctx.boardCounts.committed,
      skipped: ctx.boardCounts.skipped,
      stale: ctx.boardCounts.stale || 0,
      total: ctx.boardCounts.total,
    },
    staleEvents: ctx.staleEventCount,
    filesChanged: runGit.filesChanged,
    finalGitStatus: runGit.finalGitStatus,
    deliverables: runGit.deliverables,
    agents: ctx.agentStats,
    contract: ctx.contract ? ctx.cloneContract(ctx.contract) : undefined,
    maxTierReached: ctx.currentTier > 0 ? ctx.currentTier : undefined,
    tiersCompleted: ctx.currentTier > 0 ? ctx.tiersCompleted : undefined,
    tierHistory: ctx.tierHistory.length > 0 ? ctx.tierHistory.slice() : undefined,
    transcript: ctx.transcript,
    v2State: ctx.v2State,
    v2QueueState: ctx.v2QueueState,
    topology: cfg.topology,
    errors: ctx.errorTracker,
    ...(ctx.controlAdvice?.length ? { controlAdvice: ctx.controlAdvice } : {}),
    ...((): { applyIntegrity?: import("@ollama-swarm/shared/applyIntegrityReport").ApplyIntegrityReport } => {
      const applyIntegrity = snapshotApplyIntegrityForRun(cfg.runId);
      return applyIntegrity ? { applyIntegrity } : {};
    })(),
    ...((): { cycleIntegrity?: import("@ollama-swarm/shared/cycleIntegrityReport").CycleIntegrityReport } => {
      const cycleIntegrity = snapshotCycleIntegrityForRun(cfg.runId);
      return cycleIntegrity ? { cycleIntegrity } : {};
    })(),
    ...((): { researchIntegrity?: import("../research/researchBudget.js").ResearchIntegrityReport } => {
      const researchIntegrity = snapshotResearchIntegrity(cfg.runId);
      return researchIntegrity ? { researchIntegrity } : {};
    })(),
  });

  // Full start-form snapshot (directive, topology, MCP, caps, flags) for Load params.
  try {
    const { captureStartConfigFromRunConfig } = await import(
      "@ollama-swarm/shared/startConfigSnapshot"
    );
    const startConfig = captureStartConfigFromRunConfig(cfg as any);
    summary = {
      ...summary,
      startConfig,
      ...(startConfig.userDirective ? { userDirective: startConfig.userDirective } : {}),
      ...(startConfig.webTools !== undefined ? { webTools: startConfig.webTools } : {}),
      ...(startConfig.mcpServers ? { mcpServers: startConfig.mcpServers } : {}),
      ...(startConfig.autoApprove !== undefined ? { autoApprove: startConfig.autoApprove } : {}),
      ...(startConfig.writeMode ? { writeMode: startConfig.writeMode } : {}),
      ...(startConfig.conflictPolicy ? { conflictPolicy: startConfig.conflictPolicy } : {}),
      ...(startConfig.councilSharedExplore !== undefined
        ? { councilSharedExplore: startConfig.councilSharedExplore }
        : {}),
      ...(startConfig.councilSharedResearch !== undefined
        ? { councilSharedResearch: startConfig.councilSharedResearch }
        : {}),
      ...(startConfig.councilReconcile ? { councilReconcile: startConfig.councilReconcile } : {}),
      ...(startConfig.verifyCommand ? { verifyCommand: startConfig.verifyCommand } : {}),
      ...(startConfig.preflightDryRun !== undefined
        ? { preflightDryRun: startConfig.preflightDryRun }
        : {}),
      ...(startConfig.hunkRag !== undefined ? { hunkRag: startConfig.hunkRag } : {}),
      ...(startConfig.dynamicRolePicker !== undefined
        ? { dynamicRolePicker: startConfig.dynamicRolePicker }
        : {}),
      ...(startConfig.mentionContracts !== undefined
        ? { mentionContracts: startConfig.mentionContracts }
        : {}),
      ...(startConfig.bestOfNTurn != null ? { bestOfNTurn: startConfig.bestOfNTurn } : {}),
      ...(startConfig.wallClockCapMs != null ? { wallClockCapMs: startConfig.wallClockCapMs } : {}),
      ...(startConfig.ambitionTiers != null ? { ambitionTiers: startConfig.ambitionTiers } : {}),
      ...(startConfig.plannerModel ? { plannerModel: startConfig.plannerModel } : {}),
      ...(startConfig.workerModel ? { workerModel: startConfig.workerModel } : {}),
      ...(startConfig.auditorModel ? { auditorModel: startConfig.auditorModel } : {}),
    } as typeof summary;
  } catch {
    /* best-effort */
  }

  try {
    const { loadDeliberationForSummary } = await import("../deliberation/deliberationLog.js");
    const delib = await loadDeliberationForSummary(cfg.localPath, summary.runId ?? cfg.runId);
    if (delib.length > 0) {
      summary = { ...summary, deliberation: delib };
    }
  } catch {
    /* best-effort */
  }

  const prior = ctx.getLastSummary?.();
  if (
    prior?.stopReason === "user"
    && summary.stopReason === "completed"
  ) {
    summary = {
      ...summary,
      stopReason: prior.stopReason,
      stopDetail: prior.stopDetail ?? summary.stopDetail,
    };
  }

  const json = JSON.stringify(summary, null, 2);
  const runIdShort = summary.runId ? summary.runId.slice(0, 8) : "";
  const logsDir = path.join(cfg.localPath, "logs", runIdShort || "unknown");
  try { await import("node:fs/promises").then((fs) => fs.mkdir(logsDir, { recursive: true })); } catch {}
  const perRunPath = path.join(logsDir, buildPerRunSummaryFileName(summary.startedAt, summary.runId));
  const latestPath = path.join(logsDir, "summary.json");
  try {
    await writeFileAtomic(perRunPath, json);
    await writeFileAtomic(latestPath, json);

    // Guard against duplicate "Run finished" banners + summary grids in transcript.
    // writeRunSummary can be reached via both the planAndExecute finally *and*
    // explicit calls from drain()/stop() for early termination. The banner append
    // (which renders the big RunFinishedGrid) must happen only once.
    const alreadyHasRunFinished = ctx.transcript.some(
      (e) => e.summary?.kind === "run_finished"
    );
    if (!alreadyHasRunFinished) {
      ctx.appendSystem(formatRunFinishedBanner(summary), buildRunFinishedSummary(summary));
      ctx.appendSystem(
        `Wrote run summary to ${perRunPath} + ${latestPath} (stopReason=${summary.stopReason}, commits=${summary.commits}, files=${summary.filesChanged}).`,
      );
    }
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    ctx.appendSystem(`Failed to write run summary (${msg})`);
  }
  // Free process-scoped per-run telemetry after snapshot (maps would otherwise grow).
  try {
    const { clearRunTelemetry } = await import("../runTelemetryCleanup.js");
    clearRunTelemetry(cfg.runId);
  } catch {
    /* non-fatal */
  }
  ctx.lastSummarySetter(summary);
  ctx.emit({ type: "run_summary", summary });

  if (config.PROJECT_GRAPH_ENABLED) {
    void import("../../projectGraph/service.js")
      .then(({ updateProjectGraphSidecarForSummary }) =>
        updateProjectGraphSidecarForSummary({
          runId: summary.runId,
          preset: summary.preset,
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
          stopReason: summary.stopReason,
          localPath: summary.localPath ?? cfg.localPath,
          deliverables: summary.deliverables,
          finalGitStatus: runGit.finalGitStatus,
        }),
      )
      .catch((err) => {
        console.warn(
          "[projectGraph] sidecar merge failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  // Always write project-level summary.json (independent of clone + run_finished banner).
  // Prior bug: this block was gated on !alreadyHasRunFinished, but the banner above
  // already appended run_finished — so project-level write was skipped (926054b0).
  try {
    const fs = await import("node:fs/promises");
    const runId = summary.runId || cfg.runId || "unknown";
    const roots = new Set<string>([
      path.join(process.cwd(), "logs", runId),
      // When server is started from monorepo root vs server/, mirror both layouts.
      path.join(process.cwd(), "server", "logs", runId),
    ]);
    // Also mirror under server package when cwd is server/
    if (path.basename(process.cwd()) === "server") {
      roots.add(path.join(process.cwd(), "logs", runId));
    }
    for (const projectLogsDir of roots) {
      try {
        await fs.mkdir(projectLogsDir, { recursive: true });
        const projPath = path.join(projectLogsDir, "summary.json");
        await writeFileAtomic(projPath, json);
      } catch {
        /* best effort per root */
      }
    }
    const alreadyLogged = ctx.transcript.some(
      (e) => e.role === "system" && typeof e.text === "string" && e.text.includes("Canonical project-level summary"),
    );
    if (!alreadyLogged) {
      ctx.appendSystem(
        `Canonical project-level summary written under logs/${runId}/summary.json`,
      );
    }

    // Compact index record
    try {
      const indexEntry = {
        runId: summary.runId,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt ?? Date.now(),
        stopReason: summary.stopReason,
        preset: summary.preset,
        commits: summary.commits ?? 0,
        filesChanged: summary.filesChanged ?? 0,
        wallClockMs: summary.wallClockMs,
      };
      const indexPath = path.join(process.cwd(), "logs", "runs-index.jsonl");
      await fs.appendFile(indexPath, JSON.stringify(indexEntry) + "\n", "utf8");
    } catch {
      /* best effort */
    }
  } catch {
    // best effort only
  }
}