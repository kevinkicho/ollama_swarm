/**
 * Full start-form parameter snapshot for resume / "Load params on Start page".
 * Written into summary.json as `startConfig` so history can restore every field
 * the Setup form sent (not just preset/model).
 */

import type { Topology } from "./topology.js";

/** Shape stored on summary.json and in browser sessionStorage / recent-runs. */
export interface StartConfigSnapshot {
  /** GitHub URL (optional). */
  repoUrl?: string;
  /**
   * Workspace / clone path for the form's "Project folder" field.
   * Prefer the run's localPath (actual clone), not the parent of the clone.
   */
  parentPath?: string;
  /** Alias for clarity when reading from summary.localPath. */
  localPath?: string;
  presetId?: string;
  /** Same as presetId — summaries use `preset`. */
  preset?: string;
  model?: string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  agentCount?: number;
  rounds?: number;
  topology?: Topology;
  userDirective?: string;
  /** Form field name for directive. */
  directive?: string;
  webTools?: boolean;
  autoApprove?: boolean;
  mcpServers?: string;
  writeMode?: "none" | "single" | "multi";
  conflictPolicy?: "merge" | "sequential" | "vote" | "judge" | "pick";
  councilSharedExplore?: boolean;
  councilSharedResearch?: boolean;
  councilReconcile?: "revise" | "vote" | "judge";
  verifyCommand?: string;
  preflightDryRun?: boolean;
  hunkRag?: boolean;
  dynamicRolePicker?: boolean;
  mentionContracts?: boolean;
  bestOfNTurn?: number;
  /** Form uses minutes as string; server uses ms. Both accepted. */
  wallClockCapMin?: string;
  wallClockCapMs?: number;
  ambitionTiers?: number | string;
  dedicatedAuditor?: boolean;
  runId?: string;
}

/** Loose RunConfig-like object (server RunConfig or partial). */
export type RunConfigLike = {
  repoUrl?: string;
  localPath?: string;
  preset?: string;
  model?: string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  agentCount?: number;
  rounds?: number;
  topology?: Topology;
  userDirective?: string;
  webTools?: boolean;
  autoApprove?: boolean;
  mcpServers?: string;
  writeMode?: StartConfigSnapshot["writeMode"];
  conflictPolicy?: StartConfigSnapshot["conflictPolicy"];
  councilSharedExplore?: boolean;
  councilSharedResearch?: boolean;
  councilReconcile?: StartConfigSnapshot["councilReconcile"];
  verifyCommand?: string;
  preflightDryRun?: boolean;
  hunkRag?: boolean;
  dynamicRolePicker?: boolean;
  mentionContracts?: boolean;
  bestOfNTurn?: number;
  wallClockCapMs?: number;
  ambitionTiers?: number;
  dedicatedAuditor?: boolean;
  runId?: string;
};

/** Pull planner/worker/auditor model overrides from topology rows when present. */
export function modelsFromTopology(topology?: Topology | null): {
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
} {
  if (!topology?.agents?.length) return {};
  const agents = topology.agents;
  const byRole = (role: string) =>
    agents.find((a) => String(a.role).toLowerCase() === role)?.model?.trim() || undefined;
  const plannerModel = byRole("planner") ?? byRole("orchestrator") ?? byRole("lead");
  // First non-planner implementer-like model
  const worker =
    agents.find((a) => {
      const r = String(a.role).toLowerCase();
      return (
        r === "worker"
        || r === "drafter"
        || r === "implementer"
        || r === "explorer"
        || r === "peer"
      );
    })?.model?.trim();
  const auditorModel = byRole("auditor") ?? byRole("judge") ?? byRole("critic");
  return {
    plannerModel,
    workerModel: worker,
    auditorModel,
  };
}

/**
 * Capture every start-relevant field from a live RunConfig for summary.json.
 */
/** Prefer live topology length over stale agentCount (cfg often lags grid). */
export function resolveAgentCount(
  topology?: Topology | null,
  agentCount?: number,
  agentsLen?: number,
): number | undefined {
  const topoN = topology?.agents?.length;
  const candidates = [topoN, agentsLen, agentCount].filter(
    (n): n is number => typeof n === "number" && n > 0,
  );
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

export function captureStartConfigFromRunConfig(cfg: RunConfigLike): StartConfigSnapshot {
  const topo = cfg.topology;
  const fromTopo = modelsFromTopology(topo);
  const wallMs = cfg.wallClockCapMs;
  const wallClockCapMin =
    wallMs != null && wallMs > 0
      ? String(Math.max(1, Math.round(wallMs / 60_000)))
      : wallMs === 0
        ? "0"
        : undefined;
  const agentCount = resolveAgentCount(topo, cfg.agentCount);

  const snap: StartConfigSnapshot = {
    repoUrl: cfg.repoUrl?.trim() || undefined,
    parentPath: cfg.localPath?.trim() || undefined,
    localPath: cfg.localPath?.trim() || undefined,
    presetId: cfg.preset,
    preset: cfg.preset,
    model: cfg.model?.trim() || undefined,
    plannerModel: cfg.plannerModel?.trim() || fromTopo.plannerModel,
    workerModel: cfg.workerModel?.trim() || fromTopo.workerModel,
    auditorModel: cfg.auditorModel?.trim() || fromTopo.auditorModel,
    agentCount,
    rounds: cfg.rounds,
    topology: topo,
    userDirective: cfg.userDirective?.trim() || undefined,
    directive: cfg.userDirective?.trim() || undefined,
    webTools: cfg.webTools,
    autoApprove: cfg.autoApprove,
    mcpServers: cfg.mcpServers?.trim() || undefined,
    writeMode: cfg.writeMode,
    conflictPolicy: cfg.conflictPolicy,
    councilSharedExplore: cfg.councilSharedExplore,
    councilSharedResearch: cfg.councilSharedResearch,
    councilReconcile: cfg.councilReconcile,
    verifyCommand: cfg.verifyCommand?.trim() || undefined,
    preflightDryRun: cfg.preflightDryRun,
    hunkRag: cfg.hunkRag,
    dynamicRolePicker: cfg.dynamicRolePicker,
    mentionContracts: cfg.mentionContracts,
    bestOfNTurn: cfg.bestOfNTurn,
    wallClockCapMin,
    wallClockCapMs: wallMs,
    ambitionTiers: cfg.ambitionTiers,
    dedicatedAuditor: cfg.dedicatedAuditor,
    runId: cfg.runId,
  };
  return snap;
}

/**
 * Read startConfig from a summary.json object (new field or legacy top-level).
 */
export function extractStartConfigFromSummary(summary: Record<string, unknown> | null | undefined): StartConfigSnapshot {
  if (!summary || typeof summary !== "object") return {};
  const nested =
    summary.startConfig && typeof summary.startConfig === "object"
      ? (summary.startConfig as StartConfigSnapshot)
      : {};
  const topo =
    (nested.topology as Topology | undefined)
    ?? (summary.topology as Topology | undefined);
  const fromTopo = modelsFromTopology(topo);
  const localPath = String(
    nested.localPath || nested.parentPath || summary.localPath || summary.clonePath || "",
  ).trim();
  const directive = String(
    nested.userDirective || nested.directive || summary.userDirective || "",
  ).trim();
  const wallMs =
    typeof nested.wallClockCapMs === "number"
      ? nested.wallClockCapMs
      : typeof summary.wallClockCapMs === "number"
        ? (summary.wallClockCapMs as number)
        : undefined;

  return {
    ...nested,
    repoUrl: String(nested.repoUrl || summary.repoUrl || "").trim() || undefined,
    parentPath: localPath || undefined,
    localPath: localPath || undefined,
    presetId: String(nested.presetId || nested.preset || summary.preset || "").trim() || undefined,
    preset: String(nested.preset || nested.presetId || summary.preset || "").trim() || undefined,
    model: String(nested.model || summary.model || "").trim() || undefined,
    plannerModel:
      nested.plannerModel?.trim()
      || fromTopo.plannerModel
      || (typeof summary.plannerModel === "string" ? summary.plannerModel : undefined),
    workerModel:
      nested.workerModel?.trim()
      || fromTopo.workerModel
      || (typeof summary.workerModel === "string" ? summary.workerModel : undefined),
    auditorModel:
      nested.auditorModel?.trim()
      || fromTopo.auditorModel
      || (typeof summary.auditorModel === "string" ? summary.auditorModel : undefined),
    agentCount: resolveAgentCount(
      topo,
      nested.agentCount
        ?? (typeof summary.agentCount === "number" ? summary.agentCount : undefined),
      Array.isArray(summary.agents) ? summary.agents.length : undefined,
    ),
    rounds:
      nested.rounds
      ?? (typeof summary.rounds === "number" ? summary.rounds : undefined),
    topology: topo,
    userDirective: directive || undefined,
    directive: directive || undefined,
    webTools:
      nested.webTools
      ?? (typeof summary.webTools === "boolean" ? summary.webTools : undefined),
    autoApprove:
      nested.autoApprove
      ?? (typeof summary.autoApprove === "boolean" ? summary.autoApprove : undefined),
    mcpServers: String(nested.mcpServers || summary.mcpServers || "").trim() || undefined,
    writeMode: nested.writeMode ?? (summary.writeMode as StartConfigSnapshot["writeMode"]),
    conflictPolicy:
      nested.conflictPolicy
      ?? (summary.conflictPolicy as StartConfigSnapshot["conflictPolicy"]),
    councilSharedExplore:
      nested.councilSharedExplore
      ?? (typeof summary.councilSharedExplore === "boolean"
        ? summary.councilSharedExplore
        : undefined),
    councilSharedResearch:
      nested.councilSharedResearch
      ?? (typeof summary.councilSharedResearch === "boolean"
        ? summary.councilSharedResearch
        : undefined),
    councilReconcile:
      nested.councilReconcile
      ?? (summary.councilReconcile as StartConfigSnapshot["councilReconcile"]),
    verifyCommand: String(nested.verifyCommand || summary.verifyCommand || "").trim() || undefined,
    preflightDryRun:
      nested.preflightDryRun
      ?? (typeof summary.preflightDryRun === "boolean" ? summary.preflightDryRun : undefined),
    hunkRag:
      nested.hunkRag
      ?? (typeof summary.hunkRag === "boolean" ? summary.hunkRag : undefined),
    dynamicRolePicker:
      nested.dynamicRolePicker
      ?? (typeof summary.dynamicRolePicker === "boolean"
        ? summary.dynamicRolePicker
        : undefined),
    mentionContracts:
      nested.mentionContracts
      ?? (typeof summary.mentionContracts === "boolean"
        ? summary.mentionContracts
        : undefined),
    bestOfNTurn:
      nested.bestOfNTurn
      ?? (typeof summary.bestOfNTurn === "number" ? summary.bestOfNTurn : undefined),
    wallClockCapMs: wallMs,
    wallClockCapMin:
      nested.wallClockCapMin
      ?? (wallMs != null && wallMs > 0
        ? String(Math.max(1, Math.round(wallMs / 60_000)))
        : undefined),
    ambitionTiers:
      nested.ambitionTiers
      ?? (typeof summary.ambitionTiers === "number" || typeof summary.ambitionTiers === "string"
        ? summary.ambitionTiers
        : typeof summary.maxTierReached === "number" && summary.maxTierReached > 0
          ? summary.maxTierReached
          : undefined),
    dedicatedAuditor:
      nested.dedicatedAuditor
      ?? (typeof summary.dedicatedAuditor === "boolean" ? summary.dedicatedAuditor : undefined),
    runId: String(nested.runId || summary.runId || "").trim() || undefined,
  };
}
