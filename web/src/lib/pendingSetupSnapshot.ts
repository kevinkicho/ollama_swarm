/**
 * Bridge: Run history modal → Setup form with full parameter restore.
 *
 * Uses localStorage (not sessionStorage) and StrictMode-safe consume:
 * React 18 StrictMode double-mounts effects in dev — a one-shot
 * removeItem on first mount loses the snapshot on the second.
 */

import {
  extractStartConfigFromSummary,
  resolveAgentCount,
  type StartConfigSnapshot,
} from "@ollama-swarm/shared/startConfigSnapshot";
import type { RecentRun, RecentRunSnapshotInput } from "../components/setup/RecentRuns";
import type { RunSummary, RunSummaryDigest } from "../types";

export const PENDING_SETUP_SNAPSHOT_KEY = "ollama-swarm:pending-setup-snapshot";

type StoredPending = RecentRunSnapshotInput & {
  _stashedAt?: number;
  /** Set after first successful apply; remounts within TTL may re-apply. */
  _appliedAt?: number;
};

const APPLY_TTL_MS = 8_000;

/** Write snapshot then navigate to `/?` (setup). */
export function stashPendingSetupSnapshot(input: RecentRunSnapshotInput): void {
  try {
    const payload: StoredPending = {
      ...input,
      _stashedAt: Date.now(),
      // clear any prior apply mark
    };
    delete (payload as { _appliedAt?: number })._appliedAt;
    localStorage.setItem(PENDING_SETUP_SNAPSHOT_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

/** Peek without clearing — used to skip URL preset clobber. */
export function peekPendingSetupSnapshot(): boolean {
  try {
    const raw = localStorage.getItem(PENDING_SETUP_SNAPSHOT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as StoredPending;
    if (!parsed || typeof parsed !== "object") return false;
    const at = parsed._stashedAt ?? 0;
    // Expire stale snapshots (overnight leftover).
    if (at && Date.now() - at > 30 * 60_000) {
      localStorage.removeItem(PENDING_SETUP_SNAPSHOT_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read pending snapshot for Setup restore.
 * Does NOT remove immediately — marks applied and clears after TTL so
 * React StrictMode remounts still see the data.
 */
export function consumePendingSetupSnapshot(): RecentRunSnapshotInput | null {
  try {
    const raw = localStorage.getItem(PENDING_SETUP_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPending;
    if (!parsed || typeof parsed !== "object") return null;

    const now = Date.now();
    if (parsed._appliedAt && now - parsed._appliedAt > APPLY_TTL_MS) {
      localStorage.removeItem(PENDING_SETUP_SNAPSHOT_KEY);
      return null;
    }

    // First apply this navigation
    if (!parsed._appliedAt) {
      parsed._appliedAt = now;
      localStorage.setItem(PENDING_SETUP_SNAPSHOT_KEY, JSON.stringify(parsed));
      // Hard clear after TTL
      window.setTimeout(() => {
        try {
          const cur = localStorage.getItem(PENDING_SETUP_SNAPSHOT_KEY);
          if (!cur) return;
          const p = JSON.parse(cur) as StoredPending;
          if (p._appliedAt && Date.now() - p._appliedAt >= APPLY_TTL_MS - 50) {
            localStorage.removeItem(PENDING_SETUP_SNAPSHOT_KEY);
          }
        } catch {
          localStorage.removeItem(PENDING_SETUP_SNAPSHOT_KEY);
        }
      }, APPLY_TTL_MS);
    }

    const {
      _stashedAt: _s,
      _appliedAt: _a,
      ...rest
    } = parsed;
    return rest as RecentRunSnapshotInput;
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
  const workspace = (sc.parentPath || sc.localPath || "").trim();
  const agentCount = resolveAgentCount(sc.topology, sc.agentCount);
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
    agentCount,
    rounds: sc.rounds,
    topology: sc.topology,
    webTools: sc.webTools,
    autoApprove: sc.autoApprove,
    mcpServers: sc.mcpServers ?? "",
    writeMode: sc.writeMode,
    conflictPolicy: sc.conflictPolicy,
    councilSharedExplore: sc.councilSharedExplore,
    councilSharedResearch: sc.councilSharedResearch,
    councilReconcile: sc.councilReconcile,
    verifyCommand: sc.verifyCommand ?? "",
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
  const base: Record<string, unknown> = summary
    ? (summary as unknown as Record<string, unknown>)
    : {
        localPath: digest.clonePath,
        preset: digest.preset,
        model: digest.model,
        runId: digest.runId,
        topology: digest.topology,
        agentCount: digest.agentCount,
      };
  const sc = extractStartConfigFromSummary(base);

  // Workspace = clone path for this run
  const clone = String(sc.localPath || sc.parentPath || digest.clonePath || "").trim();
  sc.parentPath = clone;
  sc.localPath = clone;

  if (!sc.topology && digest.topology) sc.topology = digest.topology;
  if (!sc.presetId && !sc.preset) {
    sc.presetId = digest.preset;
    sc.preset = digest.preset;
  }
  if (!sc.model && digest.model) sc.model = digest.model;
  if (!sc.runId && digest.runId) sc.runId = digest.runId;
  sc.agentCount = resolveAgentCount(
    sc.topology,
    sc.agentCount ?? digest.agentCount,
    Array.isArray(summary?.agents) ? summary!.agents.length : undefined,
  );

  return startConfigToRecentInput(sc);
}

/** Convert stash input into RecentRun shape for refillFromRecent. */
export function snapshotInputToRecentRun(input: RecentRunSnapshotInput): RecentRun {
  const directive = (input.directive || "").trim();
  const agentCount = resolveAgentCount(input.topology, input.agentCount);
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
    agentCount,
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
