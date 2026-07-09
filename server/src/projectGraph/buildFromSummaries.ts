import type {
  GraphRunSummary,
  ProjectGraph,
  ProjectGraphAnchors,
  ProjectGraphEdge,
  ProjectGraphNode,
} from "./types.js";

export const MAX_GRAPH_NODES = 500;
export const MAX_HOT_FILES = 30;
export const MISSION_FILE_CANDIDATES = [
  "README.md",
  "docs/STATUS.md",
  "docs/AGENT-GUIDE.md",
];

function runNodeId(runId: string): string {
  return `run:${runId}`;
}

function fileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

function workspaceNodeId(workspacePath: string): string {
  return `workspace:${workspacePath}`;
}

/** Pure: build a project graph from run summaries (L1 swarm evolution). */
export function buildFromSummaries(
  workspacePath: string,
  summaries: readonly GraphRunSummary[],
  updatedAt = Date.now(),
): ProjectGraph {
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];
  const fileTouch = new Map<string, { count: number; lastRunId?: string; lastStartedAt?: number }>();

  nodes.push({
    id: workspaceNodeId(workspacePath),
    kind: "workspace",
    label: workspacePath.split(/[/\\]/).pop() || workspacePath,
  });

  const sorted = [...summaries].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  for (const s of sorted) {
    const runId = s.runId?.trim();
    if (!runId) continue;

    const rid = runNodeId(runId);
    nodes.push({
      id: rid,
      kind: "run",
      label: runId.slice(0, 8),
      runId,
      preset: s.preset,
      stopReason: s.stopReason,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    });
    edges.push({
      from: rid,
      to: workspaceNodeId(workspacePath),
      kind: "run_on_workspace",
    });

    const deliverables = s.deliverables ?? [];
    for (const d of deliverables) {
      const fp = d.path.replace(/\\/g, "/").trim();
      if (!fp) continue;
      const fid = fileNodeId(fp);
      if (!nodes.some((n) => n.id === fid)) {
        nodes.push({
          id: fid,
          kind: "file",
          label: fp,
          path: fp,
          status: d.status,
        });
      }
      edges.push({
        from: rid,
        to: fid,
        kind: d.status,
      });
      const prev = fileTouch.get(fp) ?? { count: 0 };
      fileTouch.set(fp, {
        count: prev.count + 1,
        lastRunId: runId,
        lastStartedAt: s.startedAt ?? prev.lastStartedAt,
      });
    }
  }

  const hotFiles = [...fileTouch.entries()]
    .map(([path, meta]) => ({
      path,
      runCount: meta.count,
      lastRunId: meta.lastRunId,
      lastStartedAt: meta.lastStartedAt,
    }))
    .sort((a, b) => b.runCount - a.runCount || (b.lastStartedAt ?? 0) - (a.lastStartedAt ?? 0))
    .slice(0, MAX_HOT_FILES);

  const missionFiles = MISSION_FILE_CANDIDATES.filter((p) => fileTouch.has(p));

  const anchors: ProjectGraphAnchors = { missionFiles, hotFiles };

  const capped = capGraph(nodes, edges);

  return {
    version: 1,
    workspacePath,
    updatedAt,
    nodes: capped.nodes,
    edges: capped.edges,
    anchors,
    stats: {
      runCount: sorted.filter((s) => s.runId).length,
      fileCount: capped.nodes.filter((n) => n.kind === "file").length,
      edgeCount: capped.edges.length,
    },
  };
}

function capGraph(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
  if (nodes.length <= MAX_GRAPH_NODES) return { nodes, edges };
  const keep = new Set<string>();
  for (const n of nodes) {
    keep.add(n.id);
    if (n.kind === "workspace") continue;
    if (keep.size >= MAX_GRAPH_NODES) break;
  }
  // Always keep workspace + all runs; trim file nodes if needed
  const workspace = nodes.find((n) => n.kind === "workspace");
  const runs = nodes.filter((n) => n.kind === "run");
  const files = nodes.filter((n) => n.kind === "file");
  const room = MAX_GRAPH_NODES - 1 - runs.length;
  const keptFiles = room > 0 ? files.slice(0, room) : [];
  const keptNodes = [
    ...(workspace ? [workspace] : []),
    ...runs,
    ...keptFiles,
  ];
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
  return { nodes: keptNodes, edges: keptEdges };
}