import path from "node:path";
import { config } from "../config.js";
import { scanForRunDigests, type RunSummaryDigest } from "../services/RunsScanner.js";
import { buildFromSummaries } from "./buildFromSummaries.js";
import {
  DEFAULT_AGENT_SLICE_MAX_CHARS,
  formatAgentSlice,
} from "./formatAgentSlice.js";
import { loadSummariesForClone } from "./loadSummaries.js";
import { analyzeProjectGraphForBrain } from "./graphLibrarian.js";
import { readProjectGraphSidecar } from "./sidecar.js";
import type { GraphRunSummary, ProjectGraphApiResponse } from "./types.js";

export const PROJECT_GRAPH_CACHE_TTL_MS = 45_000;

let graphCache: {
  key: string;
  at: number;
  value: ProjectGraphApiResponse;
} | null = null;

export function clearProjectGraphCache(): void {
  graphCache = null;
}

export interface ProjectGraphQueryOpts {
  parentPath?: string;
  clonePath?: string;
  refresh?: boolean;
  includeGit?: boolean;
  includeStructure?: boolean;
  refreshLayers?: boolean;
  parentsToScan: Set<string>;
  activeClone?: string | null;
  activeRunId?: string | null;
}

function cacheKey(opts: ProjectGraphQueryOpts, workspacePath: string): string {
  return `${workspacePath}|${[...opts.parentsToScan].sort().join("\n")}|refresh=${opts.refresh ? 1 : 0}`;
}

function resolveWorkspacePath(
  opts: ProjectGraphQueryOpts,
  digests: RunSummaryDigest[],
): string {
  if (opts.clonePath) return path.resolve(opts.clonePath);
  const active = digests.find((d) => d.isActive && d.clonePath);
  if (active?.clonePath) return path.resolve(active.clonePath);
  if (digests.length > 0 && digests[0].clonePath) return path.resolve(digests[0].clonePath);
  if (opts.parentPath) return path.resolve(opts.parentPath);
  return "";
}

function toApiResponse(
  graph: ReturnType<typeof buildFromSummaries> | import("./types.js").ProjectGraph,
  source: "sidecar" | "rebuilt",
  stale: boolean,
  layers?: { git?: boolean; structure?: boolean },
  extra?: { activeRunId?: string | null },
): ProjectGraphApiResponse {
  const brainInsights = analyzeProjectGraphForBrain(graph);
  return {
    workspacePath: graph.workspacePath,
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      anchors: graph.anchors,
      stats: graph.stats,
    },
    ...(layers?.git && graph.gitLayer ? { gitLayer: graph.gitLayer } : {}),
    ...(layers?.structure && graph.structureLayer ? { structureLayer: graph.structureLayer } : {}),
    insights: {
      summaryLines: brainInsights.summaryLines,
      overTouchedFiles: brainInsights.overTouchedFiles,
      suggestedScope: brainInsights.suggestedScope,
    },
    ...(extra?.activeRunId ? { activeRunId: extra.activeRunId } : {}),
    source,
    stale,
    updatedAt: graph.updatedAt,
  };
}

export async function getProjectGraph(opts: ProjectGraphQueryOpts): Promise<ProjectGraphApiResponse | null> {
  const { runs: digests } = await scanForRunDigests(opts.parentsToScan, {
    activeClone: opts.activeClone ?? null,
    activeRunId: opts.activeRunId ?? null,
  });

  const workspacePath = resolveWorkspacePath(opts, digests);
  if (!workspacePath) return null;

  const key = cacheKey(opts, workspacePath);
  const now = Date.now();
  if (!opts.refresh && graphCache && graphCache.key === key && now - graphCache.at < PROJECT_GRAPH_CACHE_TTL_MS) {
    return graphCache.value;
  }

  let source: "sidecar" | "rebuilt" = "rebuilt";
  let stale = false;

  const layerOpts = {
    git: opts.includeGit !== false,
    structure: opts.includeStructure === true,
  };

  let graph: import("./types.js").ProjectGraph | null = null;

  const summaries = await loadSummariesForClone(workspacePath);
  const filtered = filterSummariesForWorkspace(summaries, digests, workspacePath);
  const summaryInput = filtered.length > 0 ? filtered : summaries;

  if (!opts.refresh) {
    graph = await readProjectGraphSidecar(workspacePath);
    if (graph && graph.workspacePath === workspacePath) {
      source = "sidecar";
      const latestRun = digests
        .filter((d) => d.clonePath && path.resolve(d.clonePath) === workspacePath)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      if (latestRun?.runId) {
        const hasRun = graph.nodes.some((n) => n.kind === "run" && n.runId === latestRun.runId);
        stale = !hasRun && (latestRun.endedAt ?? 0) > 0;
      }
      // Sidecar may exist but lack file edges (e.g. empty deliverables at merge time).
      const rebuilt = buildFromSummaries(workspacePath, summaryInput);
      if (graph.stats.fileCount === 0 && rebuilt.stats.fileCount > 0) {
        graph = rebuilt;
        source = "rebuilt";
        stale = false;
      }
    } else {
      graph = null;
    }
  }

  if (!graph) {
    graph = buildFromSummaries(workspacePath, summaryInput);
    source = "rebuilt";
  }

  if (opts.refreshLayers && config.PROJECT_GRAPH_ENABLED) {
    const { writeProjectGraphSidecar } = await import("./sidecar.js");
    const { enrichProjectGraphLayers } = await import("./enrichLayers.js");
    await writeProjectGraphSidecar(workspacePath, graph);
    const enriched = await enrichProjectGraphLayers(workspacePath, {
      refreshGit: layerOpts.git,
      refreshStructure: layerOpts.structure,
      force: true,
    });
    if (enriched) graph = enriched;
  } else if (
    layerOpts.git &&
    config.PROJECT_GRAPH_GIT_LAYER &&
    !graph.gitLayer &&
    config.PROJECT_GRAPH_ENABLED
  ) {
    const { buildGitHistoryLayer } = await import("./gitHistory.js");
    const gitLayer = await buildGitHistoryLayer(workspacePath);
    if (gitLayer) graph.gitLayer = gitLayer;
  }

  const response = toApiResponse(graph, source, stale, layerOpts, {
    activeRunId: opts.activeRunId,
  });
  graphCache = { key, at: now, value: response };
  return response;
}

function filterSummariesForWorkspace(
  summaries: GraphRunSummary[],
  digests: RunSummaryDigest[],
  workspacePath: string,
): GraphRunSummary[] {
  const ws = path.resolve(workspacePath);
  const runIds = new Set(
    digests
      .filter((d) => d.clonePath && path.resolve(d.clonePath) === ws && d.runId)
      .map((d) => d.runId as string),
  );
  if (runIds.size === 0) return summaries;
  return summaries.filter((s) => s.runId && runIds.has(s.runId));
}

/** Fire-and-forget sidecar update after a run ends. */
export async function updateProjectGraphSidecarForSummary(summary: GraphRunSummary): Promise<void> {
  const workspacePath = summary.localPath?.trim();
  if (!workspacePath || !summary.runId) return;

  const { mergeRunIntoGraph } = await import("./mergeSidecar.js");
  const { readProjectGraphSidecar, writeProjectGraphSidecar } = await import("./sidecar.js");

  const existing = await readProjectGraphSidecar(workspacePath);
  const merged = mergeRunIntoGraph(existing, workspacePath, summary);
  if (existing?.gitLayer) merged.gitLayer = existing.gitLayer;
  if (existing?.structureLayer) merged.structureLayer = existing.structureLayer;
  await writeProjectGraphSidecar(workspacePath, merged);
  const { refreshLayersAfterRun } = await import("./enrichLayers.js");
  void refreshLayersAfterRun(workspacePath);
}

export function shouldInjectProjectGraph(cfg: {
  preset?: string;
  userDirective?: string;
  projectGraphContext?: boolean;
}): boolean {
  if (cfg.projectGraphContext === false) return false;
  if (cfg.projectGraphContext === true) return true;
  return cfg.preset === "blackboard" && !!(cfg.userDirective?.trim());
}

const sliceCache = new Map<string, { at: number; slice: string }>();
const SLICE_CACHE_TTL_MS = 60_000;

/** Cached prompt slice for planner/worker injection. */
export async function getProjectGraphSliceForClone(
  clonePath: string,
  cfg: { preset?: string; userDirective?: string; projectGraphContext?: boolean },
  opts?: { maxChars?: number },
): Promise<string | undefined> {
  if (!config.PROJECT_GRAPH_ENABLED || !shouldInjectProjectGraph(cfg)) return undefined;
  const key = `${clonePath}|${opts?.maxChars ?? DEFAULT_AGENT_SLICE_MAX_CHARS}`;
  const now = Date.now();
  const hit = sliceCache.get(key);
  if (hit && now - hit.at < SLICE_CACHE_TTL_MS) return hit.slice;

  let graph = await readProjectGraphSidecar(clonePath);
  if (!graph) {
    const summaries = await loadSummariesForClone(clonePath);
    if (summaries.length === 0) return undefined;
    graph = buildFromSummaries(clonePath, summaries);
  }

  const maxChars = opts?.maxChars ?? DEFAULT_AGENT_SLICE_MAX_CHARS;
  const slice = formatAgentSlice(graph, { maxChars });
  sliceCache.set(key, { at: now, slice });
  return slice;
}