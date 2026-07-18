// localStorage-backed recent start configs for the Setup form.
// List view shows last N successful starts with full parameter snapshots
// so one click can re-fill the form (topology, MCP, models, flags, etc.).

import type { Topology } from "../../../../shared/src/topology";
import type { Provider } from "../../../../shared/src/providers";

const STORAGE_KEY = "ollama-swarm:recent-runs";
/** List view: more room than the old 3-chip strip. */
export const MAX_RECENT_RUNS = 12;
const MAX_DIRECTIVE_PREVIEW = 120;

/** Full start snapshot — enough to rehydrate SetupForm without server round-trip. */
export interface RecentRun {
  /** Opaque React key (timestamp string for legacy; prefer runId when present). */
  id: string;
  repoUrl: string;
  parentPath: string;
  presetId: string;
  directiveSnippet: string;
  directive: string;
  startedAt: number;
  wallClockCapMin?: string;
  ambitionTiers?: string;
  /** Full UUID from successful /start. */
  runId?: string;

  // ── Full form snapshot (optional for legacy localStorage entries) ──
  model?: string;
  provider?: Provider | string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  agentCount?: number;
  rounds?: number;
  topology?: Topology;
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
}

/** Fields captured at successful start (everything the form can restore). */
export type RecentRunSnapshotInput = {
  repoUrl: string;
  parentPath: string;
  presetId: string;
  directive: string;
  wallClockCapMin?: string;
  ambitionTiers?: string;
  runId?: string;
  model?: string;
  provider?: Provider | string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  agentCount?: number;
  rounds?: number;
  topology?: Topology;
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
};

export function loadRecentRuns(): RecentRun[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: RecentRun[] };
    if (!parsed.entries || !Array.isArray(parsed.entries)) return [];
    // Newest first; cap
    return parsed.entries
      .filter((e) => e && typeof e === "object")
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, MAX_RECENT_RUNS);
  } catch {
    return [];
  }
}

/**
 * Push a new entry to the front.
 * Dedup: same runId → replace; else same (repoUrl + parentPath + presetId) keeps
 * only the newest so repeated starts of the same workspace don't flood the list,
 * but each distinct runId stays (latest N).
 */
export function saveRecentRun(input: RecentRunSnapshotInput): RecentRun[] {
  try {
    const existing = loadRecentRuns();
    const directiveTrimmed = input.directive.trim();
    const snippet =
      directiveTrimmed.length > MAX_DIRECTIVE_PREVIEW
        ? `${directiveTrimmed.slice(0, MAX_DIRECTIVE_PREVIEW - 1)}…`
        : directiveTrimmed;
    const fresh: RecentRun = {
      id: input.runId?.trim() || String(Date.now()),
      repoUrl: input.repoUrl,
      parentPath: input.parentPath,
      presetId: input.presetId,
      directiveSnippet: snippet,
      directive: directiveTrimmed,
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

    const workspaceKey = (e: RecentRun) =>
      `${(e.repoUrl || "").trim()}|${(e.parentPath || "").trim()}|${(e.presetId || "").trim()}`;

    let deduped = existing.filter((e) => {
      if (fresh.runId && e.runId && e.runId === fresh.runId) return false;
      // No runId on either: collapse same workspace+preset (legacy chip behavior)
      if (!fresh.runId && !e.runId && workspaceKey(e) === workspaceKey(fresh)) return false;
      return true;
    });

    // Prefer one row per runId; keep older runs of same workspace (list view).
    // If over cap, drop oldest after unshift.
    const next = [fresh, ...deduped]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, MAX_RECENT_RUNS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: next }));
    return next;
  } catch {
    return [];
  }
}

/** Remove one entry (list trash control). */
export function removeRecentRun(id: string): RecentRun[] {
  try {
    const next = loadRecentRuns().filter((e) => e.id !== id && e.runId !== id);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: next }));
    return next;
  } catch {
    return loadRecentRuns();
  }
}

export function shortRepoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

export type RecentRunTipField = {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
};

export function formatRecentRunAgo(startedAt: number, now = Date.now()): string {
  if (!startedAt || !Number.isFinite(startedAt)) return "—";
  const dt = now - startedAt;
  if (dt < 1000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return new Date(startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildRecentRunTipFields(r: RecentRun): RecentRunTipField[] {
  const fields: RecentRunTipField[] = [
    { label: "preset", value: r.presetId?.trim() || "—", mono: true },
  ];
  if (r.repoUrl?.trim()) {
    fields.push({ label: "repo", value: shortRepoLabel(r.repoUrl.trim()), mono: true });
  }
  if (r.parentPath?.trim()) {
    fields.push({ label: "workspace", value: r.parentPath.trim(), mono: true });
  }
  if (r.model?.trim()) {
    fields.push({ label: "model", value: r.model.trim(), mono: true });
  }
  if (r.agentCount != null) {
    fields.push({ label: "agents", value: String(r.agentCount), mono: true });
  }
  if (r.mcpServers?.trim()) {
    fields.push({ label: "mcp", value: r.mcpServers.trim().slice(0, 80), mono: true });
  }
  const directive = r.directive?.trim() || r.directiveSnippet?.trim();
  if (directive) {
    fields.push({ label: "directive", value: directive, multiline: true });
  }
  fields.push({ label: "started", value: formatRecentRunAgo(r.startedAt), mono: true });
  if (r.runId?.trim()) {
    fields.push({ label: "run", value: r.runId.trim(), mono: true });
  }
  if (r.wallClockCapMin?.trim()) {
    fields.push({ label: "cap", value: `${r.wallClockCapMin.trim()} min`, mono: true });
  }
  if (r.ambitionTiers?.trim()) {
    fields.push({ label: "tiers", value: r.ambitionTiers.trim(), mono: true });
  }
  return fields;
}

export function recentRunChipLabel(
  r: Pick<RecentRun, "repoUrl" | "parentPath" | "presetId">,
): { primary: string; preset?: string } {
  let primary = "";
  if (r.repoUrl?.trim()) {
    primary = shortRepoLabel(r.repoUrl.trim());
  }
  if (!primary && r.parentPath?.trim()) {
    const path = r.parentPath.trim().replace(/\\/g, "/").replace(/\/$/, "");
    primary = path.split("/").pop() ?? path;
  }
  if (!primary) primary = r.presetId || "run";
  const preset = r.presetId && primary !== r.presetId ? r.presetId : undefined;
  return preset ? { primary, preset } : { primary };
}

/** Workspace basename for list primary column. */
export function recentRunWorkspaceLabel(r: Pick<RecentRun, "repoUrl" | "parentPath">): string {
  if (r.repoUrl?.trim()) return shortRepoLabel(r.repoUrl.trim());
  if (r.parentPath?.trim()) {
    const path = r.parentPath.trim().replace(/\\/g, "/").replace(/\/$/, "");
    return path.split("/").pop() ?? path;
  }
  return "—";
}

/** Compact flag chips for list secondary line. */
export function recentRunFlagLabels(r: RecentRun): string[] {
  const flags: string[] = [];
  if (r.webTools) flags.push("web");
  if (r.autoApprove) flags.push("auto");
  if (r.mcpServers?.trim()) flags.push("mcp");
  if (r.topology?.agents?.length) flags.push(`topo×${r.topology.agents.length}`);
  if (r.councilSharedExplore) flags.push("shared-explore");
  if (r.councilSharedResearch) flags.push("research");
  if (r.hunkRag) flags.push("hunk-rag");
  if (r.mentionContracts) flags.push("mentions");
  if (r.bestOfNTurn && r.bestOfNTurn > 1) flags.push(`best-of-${r.bestOfNTurn}`);
  if (r.writeMode && r.writeMode !== "none") flags.push(`write:${r.writeMode}`);
  return flags;
}
