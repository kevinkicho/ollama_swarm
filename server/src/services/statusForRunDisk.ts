/**
 * Disk/summary fallbacks for Orchestrator.statusForRun when the run is
 * no longer in the in-memory map.
 */

import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import nodePath from "node:path";
import type { SwarmPhase, SwarmStatus } from "../types.js";
import {
  buildTerminalStatusFromSummary,
  collectClonePathsForSummaryLookup,
  loadRunSummaryForRunId,
  lookupTerminalSummaryOnDisk,
} from "./runSummaryDiscovery.js";
import {
  buildRecoveredCrashSummary,
  recoverCrashSummaryFromSnapshot,
} from "./crashSummaryRecovery.js";
import { findRecoverableRuns, loadSnapshot } from "./RunStatePersister.js";

export type RunPathInfo = { clonePath: string; preset: string; startedAt: number };

/** Collect summary JSON paths under a clone (logs/, logs/<id>/, root). */
export function listSummaryCandidates(clonePath: string): string[] {
  const logsDir = nodePath.join(clonePath, "logs");
  let entries: string[] = [];
  try {
    entries = readdirSync(logsDir);
  } catch {
    /* no logs/ */
  }
  const candidates: string[] = [
    ...entries
      .filter((e) => /^summary-.*\.json$/.test(e))
      .map((e) => nodePath.join(logsDir, e)),
    nodePath.join(logsDir, "summary.json"),
    nodePath.join(clonePath, "summary.json"),
  ];
  try {
    for (const sub of entries) {
      const subDir = nodePath.join(logsDir, sub);
      try {
        if (existsSync(subDir) && statSync(subDir).isDirectory()) {
          const subEnts = readdirSync(subDir);
          for (const e of subEnts) {
            if (/^summary(?:-.*)?\.json$/.test(e)) {
              candidates.push(nodePath.join(subDir, e));
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return [...candidates].sort((a, b) =>
    nodePath.basename(b).localeCompare(nodePath.basename(a)),
  );
}

export function tryStatusFromSummaryFiles(
  runId: string,
  clonePath: string,
): SwarmStatus | null {
  try {
    for (const cand of listSummaryCandidates(clonePath)) {
      try {
        if (!existsSync(cand)) continue;
        const sumRaw = readFileSync(cand, "utf8");
        const sum = JSON.parse(sumRaw);
        if (
          sum
          && (!sum.runId
            || sum.runId === runId
            || (runId
              && (sum.runId.startsWith(runId) || runId.startsWith(sum.runId))))
        ) {
          const effPhase = (
            sum.stopReason === "completed"
              ? "completed"
              : sum.stopReason === "crash" || sum.stopReason === "crashed"
                ? "failed"
                : "stopped"
          ) as SwarmPhase;
          const rc = (sum as any).runConfig || { preset: sum.preset };
          const shapedAgents = Array.isArray(sum.agents)
            ? sum.agents.map((pa: any) => ({
                id: pa.agentId,
                index: pa.agentIndex,
                status: "stopped" as const,
                model: pa.model,
              }))
            : [];
          return {
            phase: effPhase,
            round: 0,
            agents: shapedAgents,
            transcript: (sum.transcript || []) as SwarmStatus["transcript"],
            contract: sum.contract,
            summary: sum,
            runId,
            runConfig: rc
              ? ({
                  ...rc,
                  clonePath: rc.clonePath || rc.localPath || clonePath,
                } as any)
              : undefined,
            runStartedAt: sum.startedAt,
            wallClockMs:
              typeof sum.wallClockMs === "number" ? sum.wallClockMs : undefined,
            endedAt: typeof sum.endedAt === "number" ? sum.endedAt : undefined,
          } as SwarmStatus;
        }
      } catch {
        /* next candidate */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function resolveEffectivePhaseFromSummaries(
  runId: string,
  snap: { phase: string; runConfig?: unknown },
  pathInfo?: RunPathInfo,
): {
  effectivePhase: SwarmPhase;
  wallClockMs?: number;
  endedAt?: number;
} {
  let effectivePhase = snap.phase as SwarmPhase;
  let wallClockMs: number | undefined;
  let endedAt: number | undefined;
  try {
    const rc = snap.runConfig as any;
    const cp = rc?.clonePath || rc?.localPath || pathInfo?.clonePath;
    if (cp) {
      for (const cand of listSummaryCandidates(cp)) {
        try {
          if (!existsSync(cand)) continue;
          const sumRaw = readFileSync(cand, "utf8");
          const sum = JSON.parse(sumRaw);
          if (
            sum
            && sum.stopReason
            && (!sum.runId
              || sum.runId === runId
              || (runId
                && (sum.runId.startsWith(runId) || runId.startsWith(sum.runId))))
          ) {
            if (sum.stopReason === "completed") effectivePhase = "completed";
            else if (sum.stopReason === "crash" || sum.stopReason === "crashed") {
              effectivePhase = "failed";
            } else effectivePhase = "stopped";
            if (typeof sum.wallClockMs === "number") wallClockMs = sum.wallClockMs;
            if (typeof sum.endedAt === "number") endedAt = sum.endedAt;
            break;
          }
        } catch {
          /* next */
        }
      }
    }
  } catch {
    /* ignore */
  }

  const terminalPhases = ["completed", "stopped", "failed"];
  if (!terminalPhases.includes(effectivePhase as string)) {
    effectivePhase = "failed";
  } else if (
    effectivePhase === "completed"
    && snap
    && !terminalPhases.includes(snap.phase as string)
  ) {
    effectivePhase = "failed";
  }
  return { effectivePhase, wallClockMs, endedAt };
}

export function loadSnapshotForRunId(
  runId: string,
  runPaths: Map<string, RunPathInfo>,
  knownParentPaths: string[],
): { snap: ReturnType<typeof loadSnapshot>; pathInfo?: RunPathInfo } {
  let pathInfo = runPaths.get(runId);
  if (!pathInfo && runId) {
    for (const [k, v] of runPaths.entries()) {
      if (k.startsWith(runId) || runId.startsWith(k)) {
        pathInfo = v;
        break;
      }
    }
  }
  let stateFilePath: string | null = pathInfo
    ? `${pathInfo.clonePath}.run-state.json`
    : null;
  let snap = stateFilePath ? loadSnapshot(stateFilePath) : null;
  if (
    snap
    && snap.runId
    && snap.runId !== runId
    && !(runId && (snap.runId.startsWith(runId) || runId.startsWith(snap.runId)))
  ) {
    snap = null;
  }
  if (!snap) {
    const recoverable = findRecoverableRuns(knownParentPaths);
    for (const rec of recoverable) {
      if (
        rec.runId === runId
        || (runId
          && (rec.runId.startsWith(runId) || runId.startsWith(rec.runId)))
      ) {
        snap = loadSnapshot(rec.stateFilePath);
        if (snap) break;
      }
    }
  }
  return { snap, pathInfo };
}

export function tryDeepLinkSummaryStatus(
  runId: string,
  knownParentPaths: string[],
  lastParentPath?: string,
): SwarmStatus | null {
  const parents = new Set<string>(knownParentPaths || []);
  try {
    parents.add(process.cwd());
  } catch {
    /* ignore */
  }
  try {
    parents.add(nodePath.join(process.cwd(), "logs"));
  } catch {
    /* ignore */
  }
  if (lastParentPath) parents.add(lastParentPath);
  const clonePaths = collectClonePathsForSummaryLookup([...parents]);
  const hit = lookupTerminalSummaryOnDisk(runId, clonePaths);
  if (hit) {
    return buildTerminalStatusFromSummary(hit.summary, runId, hit.clonePath);
  }
  return null;
}

export {
  loadRunSummaryForRunId,
  buildRecoveredCrashSummary,
  recoverCrashSummaryFromSnapshot,
};
