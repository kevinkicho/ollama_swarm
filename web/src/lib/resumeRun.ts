import type { RunConfigSnapshot, RunSummary } from "../types";
import type { Topology } from "../../../shared/src/topology";
import { loadRecentRuns } from "../components/setup/RecentRuns";

/** Shape returned by /status runConfig (PersistedRunConfig + extras). */
type PersistedRunConfigLike = {
  preset?: string;
  repoUrl?: string;
  localPath?: string;
  clonePath?: string;
  agentCount?: number;
  rounds?: number;
  model?: string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  dedicatedAuditor?: boolean;
  topology?: Topology;
  webTools?: boolean;
  plannerTools?: boolean;
  userDirective?: string;
  mcpServers?: string;
  wallClockCapMin?: string | number;
  ambitionTiers?: string | number;
  extras?: Record<string, unknown>;
};

export type ResumeStartPayload = {
  repoUrl: string;
  parentPath: string;
  preset: string;
  model?: string;
  agentCount: number;
  rounds?: number;
  topology?: Topology;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  dedicatedAuditor?: boolean;
  webTools?: boolean;
  plannerTools?: boolean;
  userDirective?: string;
  mcpServers?: string;
  wallClockCapMs?: number;
  ambitionTiers?: number;
  force?: boolean;
  /** Required by server for experimental/research presets. */
  allowExperimental?: boolean;
};

export function resumeParentPath(clonePath: string, repoUrl: string): string {
  const trimmedRepo = (repoUrl || "").trim();
  if (trimmedRepo) {
    return clonePath.replace(/[/\\][^/\\]+$/, "");
  }
  return clonePath;
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function trimDirective(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function resolveFromRecentRuns(input: {
  clonePath: string;
  repoUrl: string;
  preset: string;
  runId?: string;
}): string | undefined {
  const cloneNorm = input.clonePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parentNorm = resumeParentPath(input.clonePath, input.repoUrl)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  for (const entry of loadRecentRuns()) {
    if (entry.presetId !== input.preset) continue;
    const entryParent = entry.parentPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const workspaceMatch =
      entryParent === parentNorm
      || entryParent === cloneNorm
      || cloneNorm.startsWith(`${entryParent}/`);
    const repoMatch = !input.repoUrl || entry.repoUrl === input.repoUrl;
    const runIdMatch = input.runId && entry.runId?.startsWith(input.runId.slice(0, 8));
    if (!workspaceMatch && !runIdMatch) continue;
    if (!repoMatch && !runIdMatch) continue;
    const fromRecent = trimDirective(entry.directive);
    if (fromRecent) return fromRecent;
  }
  return undefined;
}

/** Extract userDirective from persisted run config / summary (resume fidelity). */
export function resolveResumeUserDirective(sources: {
  runConfig?: PersistedRunConfigLike | RunConfigSnapshot | null;
  summary?: RunSummary | null;
  /** Fallback: workspace path for localStorage RecentRuns lookup. */
  clonePath?: string;
  repoUrl?: string;
  preset?: string;
  runId?: string;
}): string | undefined {
  const rc = (sources.runConfig ?? {}) as PersistedRunConfigLike;
  const extras = (rc.extras ?? {}) as Record<string, unknown>;
  const fromExtras = trimDirective(extras.userDirective);
  if (fromExtras) return fromExtras;
  const fromRc = trimDirective(rc.userDirective);
  if (fromRc) return fromRc;
  const fromSummary = trimDirective(sources.summary?.userDirective);
  if (fromSummary) return fromSummary;
  const startCommand = sources.summary?.startCommand;
  if (startCommand) {
    const match = startCommand.match(/-d\s+'([\s\S]*)'\s*$/);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as { userDirective?: string };
        const fromCmd = trimDirective(parsed.userDirective);
        if (fromCmd) return fromCmd;
      } catch {
        // ignore malformed startCommand snapshots
      }
    }
  }
  const clonePath =
    sources.clonePath
    || rc.clonePath
    || rc.localPath
    || sources.summary?.localPath
    || "";
  const preset = sources.preset || rc.preset || sources.summary?.preset;
  if (clonePath && preset) {
    const fromRecent = resolveFromRecentRuns({
      clonePath,
      repoUrl: sources.repoUrl ?? rc.repoUrl ?? sources.summary?.repoUrl ?? "",
      preset,
      runId: sources.runId ?? sources.summary?.runId,
    });
    if (fromRecent) return fromRecent;
  }
  return undefined;
}

/**
 * Build a /api/swarm/start body from a finished or stopped run's stored config.
 * Returns null when workspace path or preset cannot be resolved.
 */
export function buildResumeStartPayload(sources: {
  runConfig?: RunConfigSnapshot | PersistedRunConfigLike | null;
  summary?: RunSummary | null;
}): ResumeStartPayload | null {
  const rc = (sources.runConfig ?? {}) as PersistedRunConfigLike & RunConfigSnapshot;
  const sum = sources.summary;
  const extras = (rc.extras ?? {}) as Record<string, unknown>;

  const clonePath =
    rc.clonePath
    || rc.localPath
    || sum?.localPath
    || "";
  const repoUrl = (rc.repoUrl ?? sum?.repoUrl ?? "").trim();
  const preset = rc.preset || sum?.preset;
  if (!clonePath || clonePath.length < 3 || !preset) return null;

  const topology = rc.topology
    || (extras.topology as Topology | undefined)
    || sum?.topology;

  const plannerModel = rc.plannerModel || (extras.plannerModel as string | undefined);
  const workerModel = rc.workerModel || (extras.workerModel as string | undefined);
  const auditorModel = rc.auditorModel || (extras.auditorModel as string | undefined);
  const dedicatedAuditor = rc.dedicatedAuditor ?? (extras.dedicatedAuditor as boolean | undefined);

  const agentCount = rc.agentCount ?? sum?.agentCount;
  if (agentCount == null || agentCount < 1) return null;

  const rounds = rc.rounds ?? sum?.rounds ?? 0;
  const model =
    rc.model
    || sum?.model
    || plannerModel
    || workerModel;

  const wallClockCapMin = numOrUndef(rc.wallClockCapMin ?? extras.wallClockCapMin);
  const ambitionTiers = numOrUndef(rc.ambitionTiers ?? extras.ambitionTiers);

  const webTools = rc.webTools ?? (extras.webTools as boolean | undefined) ?? sum?.webTools;
  const plannerTools = rc.plannerTools ?? (extras.plannerTools as boolean | undefined) ?? sum?.plannerTools;
  const mcpServers = (rc.mcpServers ?? extras.mcpServers) as string | undefined;
  const userDirective = resolveResumeUserDirective({
    ...sources,
    clonePath,
    repoUrl,
    preset,
    runId: sum?.runId,
  });

  // Experimental/research presets need allowExperimental on server (D12).
  let allowExperimental = false;
  try {
    // Dynamic to avoid hard web→shared cycle in tests; fall back to list.
    const experimental = new Set([
      "role-diff",
      "debate-judge",
      "map-reduce",
      "stigmergy",
      "baseline",
      "moa",
      "pipeline",
      "orchestrator-worker-deep",
    ]);
    allowExperimental = experimental.has(String(preset));
  } catch {
    allowExperimental = false;
  }

  const payload: ResumeStartPayload = {
    repoUrl,
    parentPath: resumeParentPath(clonePath, repoUrl),
    preset,
    model: model || undefined,
    agentCount,
    rounds,
    topology,
    plannerModel: plannerModel || undefined,
    workerModel: workerModel || undefined,
    auditorModel: auditorModel || undefined,
    dedicatedAuditor: dedicatedAuditor ?? undefined,
    webTools: webTools ?? undefined,
    plannerTools: plannerTools ?? undefined,
    mcpServers: mcpServers || undefined,
    force: true,
    ...(allowExperimental ? { allowExperimental: true } : {}),
  };

  if (userDirective) {
    payload.userDirective = userDirective;
  }
  if (wallClockCapMin != null && wallClockCapMin > 0) {
    payload.wallClockCapMs = wallClockCapMin * 60 * 1000;
  }
  if (ambitionTiers != null) {
    payload.ambitionTiers = ambitionTiers;
  }

  return payload;
}