/**
 * Bridge: Run history modal → Setup form with full parameter restore.
 * sessionStorage holds one pending snapshot consumed on Setup mount.
 */

import {
  extractStartConfigFromSummary,
  type StartConfigSnapshot,
} from "@ollama-swarm/shared/startConfigSnapshot";
import type { RecentRun, RecentRunSnapshotInput } from "../components/setup/RecentRuns";
import type { RunSummary, RunSummaryDigest } from "../types";

export const PENDING_SETUP_SNAPSHOT_KEY = "ollama-swarm:pending-setup-snapshot";

/** Write snapshot then navigate to `/?` (setup). */
export function stashPendingSetupSnapshot(input: RecentRunSnapshotInput): void {
  try {
    sessionStorage.setItem(
      PENDING_SETUP_SNAPSHOT_KEY,
      JSON.stringify({ ...input, _stashedAt: Date.now() }),
    );
  } catch {
    /* quota / private mode */
  }
}

/** Peek without clearing — used to skip URL preset clobber. */
export function peekPendingSetupSnapshot(): boolean {
  try {
    return !!sessionStorage.getItem(PENDING_SETUP_SNAPSHOT_KEY);
  } catch {
    return false;
  }
}

/** Read + clear pending snapshot (one-shot). */
export function consumePendingSetupSnapshot(): RecentRunSnapshotInput | null {
  try {
    const raw = sessionStorage.getItem(PENDING_SETUP_SNAPSHOT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_SETUP_SNAPSHOT_KEY);
    const parsed = JSON.parse(raw) as RecentRunSnapshotInput & { _stashedAt?: number };
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Parent of a clone path (rarely needed — prefer clone itself as workspace). */
export function parentOfClonePath(clonePath: string): string {
  const norm = clonePath.replace(/[/\\]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return norm;
  return norm.slice(0, idx);
}

function startConfigToRecentInput(sc: StartConfigSnapshot): RecentRunSnapshotInput {
  const directive = (sc.userDirective || sc.directive || "").trim();
  const workspace =
    (sc.parentPath || sc.localPath || "").trim();
  return {
    repoUrl: sc.repoUrl || "",
    parentPath: workspace,
    presetId: sc.presetId || sc.preset || "blackboard",
    directive,
    runId: sc.runId,
    model: sc.model,
    plannerModel: sc.plannerModel,
    workerModel: sc.workerModel,
    auditorModel: sc.auditorModel,
    agentCount: sc.agentCount,
    rounds: sc.rounds,
    topology: sc.topology,
    webTools: sc.webTools,
    autoApprove: sc.autoApprove,
    mcpServers: sc.mcpServers,
    writeMode: sc.writeMode,
    conflictPolicy: sc.conflictPolicy,
    councilSharedExplore: sc.councilSharedExplore,
    councilSharedResearch: sc.councilSharedResearch,
    councilReconcile: sc.councilReconcile,
    verifyCommand: sc.verifyCommand,
    preflightDryRun: sc.preflightDryRun,
    hunkRag: sc.hunkRag,
    dynamicRolePicker: sc.dynamicRolePicker,
    mentionContracts: sc.mentionContracts,
    bestOfNTurn: sc.bestOfNTurn,
    wallClockCapMin:
      sc.wallClockCapMin
      ?? (sc.wallClockCapMs != null && sc.wallClockCapMs > 0
        ? String(Math.max(1, Math.round(sc.wallClockCapMs / 60_000)))
        : sc.wallClockCapMs === 0
          ? "0"
          : undefined),
    ambitionTiers:
      sc.ambitionTiers != null ? String(sc.ambitionTiers) : undefined,
  };
}

/**
 * Map run-summary (+ digest) into a full setup refill snapshot.
 * Prefers summary.startConfig (new) then top-level legacy fields.
 */
export function snapshotFromRunSummary(
  digest: RunSummaryDigest,
  summary: RunSummary | null | undefined,
): RecentRunSnapshotInput {
  const sc = extractStartConfigFromSummary(
    (summary ?? {
      localPath: digest.clonePath,
      preset: digest.preset,
      model: digest.model,
      runId: digest.runId,
      topology: digest.topology,
      agentCount: digest.agentCount,
    }) as unknown as Record<string, unknown>,
  );
  // Ensure workspace is the clone path used for this run (form "Project folder").
  if (!sc.parentPath && !sc.localPath) {
    sc.parentPath = digest.clonePath;
    sc.localPath = digest.clonePath;
  }
  if (!sc.topology && digest.topology) sc.topology = digest.topology;
  if (!sc.presetId && !sc.preset) {
    sc.presetId = digest.preset;
    sc.preset = digest.preset;
  }
  if (!sc.model && digest.model) sc.model = digest.model;
  if (!sc.runId && digest.runId) sc.runId = digest.runId;
  if (sc.agentCount == null && digest.agentCount != null) sc.agentCount = digest.agentCount;

  return startConfigToRecentInput(sc);
}

/** Convert stash input into RecentRun shape for refillFromRecent. */
export function snapshotInputToRecentRun(input: RecentRunSnapshotInput): RecentRun {
  const directive = (input.directive || "").trim();
  return {
    id: input.runId || String(Date.now()),
    repoUrl: input.repoUrl || "",
    parentPath: input.parentPath || "",
    presetId: input.presetId || "blackboard",
    directiveSnippet: directive.slice(0, 120),
    directive,
    startedAt: Date.now(),
    wallClockCapMin: input.wallClockCapMin,
    ambitionTiers: input.ambitionTiers,
    runId: input.runId,
    model: input.model,
    provider: input.provider,
    plannerModel: input.plannerModel,
    workerModel: input.workerModel,
    auditorModel: input.auditorModel,
    agentCount: input.agentCount,
    rounds: input.rounds,
    topology: input.topology,
    webTools: input.webTools,
    autoApprove: input.autoApprove,
    mcpServers: input.mcpServers,
    writeMode: input.writeMode,
    conflictPolicy: input.conflictPolicy,
    councilSharedExplore: input.councilSharedExplore,
    councilSharedResearch: input.councilSharedResearch,
    councilReconcile: input.councilReconcile,
    verifyCommand: input.verifyCommand,
    preflightDryRun: input.preflightDryRun,
    hunkRag: input.hunkRag,
    dynamicRolePicker: input.dynamicRolePicker,
    mentionContracts: input.mentionContracts,
    bestOfNTurn: input.bestOfNTurn,
  };
}
