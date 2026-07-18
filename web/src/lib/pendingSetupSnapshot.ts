/**
 * Bridge: Run history modal → Setup form with full parameter restore.
 * sessionStorage holds one pending snapshot consumed on Setup mount.
 */

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

/** Parent of a clone path (workspace folder for setup form). */
export function parentOfClonePath(clonePath: string): string {
  const norm = clonePath.replace(/[/\\]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return norm;
  return norm.slice(0, idx);
}

/**
 * Best-effort map from run-summary (+ digest) into a setup refill snapshot.
 * Older summaries omit many fields; callers still get path/preset/model/topology when present.
 */
export function snapshotFromRunSummary(
  digest: RunSummaryDigest,
  summary: RunSummary | null | undefined,
): RecentRunSnapshotInput {
  const s = summary;
  const localPath = (s?.localPath || digest.clonePath || "").trim();
  const repoUrl = (s?.repoUrl || "").trim();
  // If summary has a github URL, parent is clone parent; else use localPath as workspace.
  const parentPath = repoUrl ? parentOfClonePath(localPath) : localPath || parentOfClonePath(digest.clonePath);
  const topology = s?.topology ?? digest.topology;
  const agentCount =
    s?.agentCount
    ?? topology?.agents?.length
    ?? (Array.isArray(s?.agents) ? s!.agents.length : undefined);
  const wallMs = s?.wallClockMs;
  const wallClockCapMin =
    wallMs && wallMs > 0 ? String(Math.max(1, Math.ceil(wallMs / 60_000))) : undefined;

  return {
    repoUrl,
    parentPath,
    presetId: s?.preset || digest.preset || "blackboard",
    directive: (s?.userDirective || "").trim(),
    runId: s?.runId || digest.runId,
    model: s?.model || digest.model || undefined,
    agentCount,
    rounds: s?.rounds,
    topology,
    webTools: s?.webTools,
    mcpServers: s?.mcpServers,
    wallClockCapMin,
    ambitionTiers: (() => {
      const tier = (s as { maxTierReached?: number } | null | undefined)?.maxTierReached;
      return tier != null && tier > 0 ? String(tier) : undefined;
    })(),
  };
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
