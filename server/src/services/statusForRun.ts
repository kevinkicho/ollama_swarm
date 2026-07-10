// statusForRun live + disk fallbacks — extracted from Orchestrator.

import type { ActiveRun } from "./ActiveRun.js";
import type { SwarmPhase, SwarmStatus, SwarmStatusRunConfig } from "../types.js";
import { normalizeSwarmStatusRunConfig } from "../types/run.js";
import {
  mergeStatusAgents,
  resolveStatusAgents,
  terminalPhaseFromStopReason,
} from "./runSummaryDiscovery.js";
import {
  loadSnapshotForRunId,
  tryDeepLinkSummaryStatus,
  tryStatusFromSummaryFiles,
  resolveEffectivePhaseFromSummaries,
  loadRunSummaryForRunId,
  buildRecoveredCrashSummary,
  recoverCrashSummaryFromSnapshot,
} from "./statusForRunDisk.js";
import type { RepoService } from "./RepoService.js";

export interface StatusForRunHost {
  runs: Map<string, ActiveRun>;
  runPaths: Map<string, { clonePath: string; preset: string; startedAt: number }>;
  knownParentPaths: string[];
  getLastParentPath: () => string | undefined;
  mergeRunConfig: (
    base: SwarmStatusRunConfig | undefined,
    live: SwarmStatusRunConfig | undefined,
  ) => SwarmStatusRunConfig | undefined;
  computeRegions: (status: SwarmStatus) => SwarmStatus["regions"];
  cacheDiskStatusForRun: (runId: string, status: SwarmStatus) => SwarmStatus;
  getDiskCache: (
    runId: string,
  ) => { at: number; status: SwarmStatus } | undefined;
  diskCacheTtlMs: number;
  repos: RepoService;
}

function resolveLiveRun(
  host: StatusForRunHost,
  runId: string,
): ActiveRun | undefined {
  let run = host.runs.get(runId);
  if (!run && runId) {
    for (const [k, v] of host.runs.entries()) {
      if (k.startsWith(runId) || runId.startsWith(k)) {
        run = v;
        break;
      }
    }
  }
  return run;
}

export function statusForRun(host: StatusForRunHost, runId: string): SwarmStatus | null {
  const cached = host.getDiskCache(runId);
  if (cached && Date.now() - cached.at < host.diskCacheTtlMs) {
    return cached.status;
  }

  const run = resolveLiveRun(host, runId);
  if (run) {
    const status = run.runner.status();
    const runConfig = host.mergeRunConfig(run.runConfig, status.runConfig) as
      | Record<string, unknown>
      | undefined;
    const roster = resolveStatusAgents({
      terminalSum: (status.summary as Record<string, unknown> | undefined) ?? null,
      clonePath: (runConfig?.clonePath ?? runConfig?.localPath) as string | undefined,
      runConfig,
      transcript: status.transcript,
    });
    const agents = mergeStatusAgents(
      status.agents as import("./runSummaryDiscovery.js").AgentStateShape[],
      roster,
    ) as SwarmStatus["agents"];
    return {
      ...status,
      agents,
      runId: run.runId,
      runConfig: host.mergeRunConfig(run.runConfig, status.runConfig),
      runStartedAt: status.runStartedAt ?? run.startedAt,
      regions: host.computeRegions(status),
    };
  }

  // Run no longer in memory — fall back to disk (snapshot / summary).
  const { snap, pathInfo } = loadSnapshotForRunId(
    runId,
    host.runPaths,
    host.knownParentPaths,
  );

  if (!snap && !pathInfo) {
    const deep = tryDeepLinkSummaryStatus(
      runId,
      host.knownParentPaths,
      host.getLastParentPath(),
    );
    if (deep) return host.cacheDiskStatusForRun(runId, deep);
  }

  if (!snap && pathInfo?.clonePath) {
    const fromSum = tryStatusFromSummaryFiles(runId, pathInfo.clonePath);
    if (fromSum) return host.cacheDiskStatusForRun(runId, fromSum);
  }

  if (!snap) return null;

  const phaseRes = resolveEffectivePhaseFromSummaries(runId, snap, pathInfo);
  let effectivePhase = phaseRes.effectivePhase;
  if (phaseRes.wallClockMs != null) (snap as any).wallClockMs = phaseRes.wallClockMs;
  if (phaseRes.endedAt != null) (snap as any).endedAt = phaseRes.endedAt;

  const rc = snap.runConfig as any;
  const cp = rc?.clonePath || rc?.localPath || pathInfo?.clonePath;
  let terminalSum = cp ? loadRunSummaryForRunId(cp, runId) : null;
  if (!terminalSum?.stopReason && cp && effectivePhase === "failed") {
    terminalSum = buildRecoveredCrashSummary(
      {
        runId: snap.runId,
        preset: snap.preset,
        phase: snap.phase,
        startedAt: snap.startedAt,
        lastEventAt: snap.lastEventAt,
        transcript: snap.transcript as import("../types.js").TranscriptEntry[],
        runConfig: rc,
      },
      cp,
      runId,
    ) as unknown as Record<string, unknown>;
    void recoverCrashSummaryFromSnapshot(
      {
        runId: snap.runId,
        preset: snap.preset,
        phase: snap.phase,
        startedAt: snap.startedAt,
        lastEventAt: snap.lastEventAt,
        transcript: snap.transcript as import("../types.js").TranscriptEntry[],
        runConfig: rc,
      },
      cp,
      runId,
      host.repos,
    ).catch(() => {});
  }
  if (terminalSum?.stopReason) {
    effectivePhase = terminalPhaseFromStopReason(terminalSum.stopReason) as SwarmPhase;
  }
  const shapedAgents = resolveStatusAgents({
    terminalSum,
    clonePath: cp,
    runConfig: rc,
    transcript: snap.transcript,
  });
  return host.cacheDiskStatusForRun(runId, {
    phase: effectivePhase,
    round: 0,
    agents: shapedAgents,
    transcript: snap.transcript as SwarmStatus["transcript"],
    contract: (snap.contract as SwarmStatus["contract"] | undefined)
      ?? (terminalSum?.contract as SwarmStatus["contract"] | undefined),
    summary: terminalSum ?? undefined,
    runId,
    runConfig: rc
      ? normalizeSwarmStatusRunConfig(
          rc as SwarmStatusRunConfig & {
            localPath?: string;
            extras?: Record<string, unknown>;
          },
        )
      : undefined,
    runStartedAt: snap.startedAt,
    wallClockMs:
      typeof terminalSum?.wallClockMs === "number"
        ? terminalSum.wallClockMs
        : phaseRes.wallClockMs,
    endedAt:
      typeof terminalSum?.endedAt === "number"
        ? terminalSum.endedAt
        : phaseRes.endedAt,
  } as SwarmStatus);
}
