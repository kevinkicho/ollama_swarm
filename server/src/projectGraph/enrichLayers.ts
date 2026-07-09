import { config } from "../config.js";
import { buildGitHistoryLayer } from "./gitHistory.js";
import { buildStructureLayer } from "./structureScan.js";
import { readProjectGraphSidecar, writeProjectGraphSidecar } from "./sidecar.js";
import type { ProjectGraph } from "./types.js";

const LAYER_MIN_INTERVAL_MS = 5 * 60_000;
const lastRefresh = new Map<string, number>();

function shouldRefreshLayer(key: string, force: boolean): boolean {
  if (force) return true;
  const prev = lastRefresh.get(key) ?? 0;
  if (Date.now() - prev < LAYER_MIN_INTERVAL_MS) return false;
  lastRefresh.set(key, Date.now());
  return true;
}

export function clearLayerRefreshCache(): void {
  lastRefresh.clear();
}

export async function enrichProjectGraphLayers(
  clonePath: string,
  opts?: { refreshGit?: boolean; refreshStructure?: boolean; force?: boolean },
): Promise<ProjectGraph | null> {
  if (!config.PROJECT_GRAPH_ENABLED) return null;

  const graph =
    (await readProjectGraphSidecar(clonePath)) ??
    null;
  if (!graph) return null;

  const force = opts?.force === true;
  const wantGit = opts?.refreshGit !== false && config.PROJECT_GRAPH_GIT_LAYER;
  // On-demand API refresh (force) may build structure without env; env gates background refresh.
  const wantStructure =
    opts?.refreshStructure === true && (force || config.PROJECT_GRAPH_STRUCTURE_LAYER);

  if (wantGit && shouldRefreshLayer(`${clonePath}:git`, force)) {
    const gitLayer = await buildGitHistoryLayer(clonePath);
    if (gitLayer) graph.gitLayer = gitLayer;
  }

  if (wantStructure && shouldRefreshLayer(`${clonePath}:structure`, force)) {
    const structureLayer = await buildStructureLayer(clonePath);
    if (structureLayer) {
      graph.structureLayer = structureLayer;
      mergeStructureIntoGraph(graph, structureLayer);
    }
  }

  graph.updatedAt = Date.now();
  await writeProjectGraphSidecar(clonePath, graph);
  return graph;
}

function mergeStructureIntoGraph(graph: ProjectGraph, layer: NonNullable<ProjectGraph["structureLayer"]>): void {
  const existingModuleIds = new Set(
    graph.nodes.filter((n) => n.kind === "module").map((n) => n.id),
  );
  for (const m of layer.modules) {
    const id = `module:${m.path}`;
    if (!existingModuleIds.has(id)) {
      graph.nodes.push({ id, kind: "module", label: m.path });
      existingModuleIds.add(id);
    }
  }
  for (const e of layer.edges.slice(0, 80)) {
    const from = `module:${e.from}`;
    const to = `module:${e.to}`;
    if (!graph.nodes.some((n) => n.id === from) || !graph.nodes.some((n) => n.id === to)) continue;
    if (graph.edges.some((x) => x.from === from && x.to === to && x.kind === "depends_on")) continue;
    graph.edges.push({ from, to, kind: "depends_on" });
  }
}

/** Background refresh after run end — never throws. */
export async function refreshLayersAfterRun(clonePath: string): Promise<void> {
  try {
    await enrichProjectGraphLayers(clonePath, {
      refreshGit: true,
      refreshStructure: false,
      force: false,
    });
  } catch {
    // best-effort
  }
}