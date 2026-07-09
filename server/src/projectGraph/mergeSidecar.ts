import { buildFromSummaries } from "./buildFromSummaries.js";
import type { GraphRunSummary, ProjectGraph } from "./types.js";

/** Pure: merge one run summary into an existing graph (or bootstrap). */
export function mergeRunIntoGraph(
  existing: ProjectGraph | null,
  workspacePath: string,
  summary: GraphRunSummary,
): ProjectGraph {
  const priorSummaries: GraphRunSummary[] = [];

  if (existing) {
    for (const node of existing.nodes) {
      if (node.kind !== "run" || !node.runId) continue;
      if (node.runId === summary.runId) continue;
      const edges = existing.edges.filter((e) => e.from === node.id && e.kind !== "run_on_workspace");
      const deliverables = edges
        .map((e) => {
          const fileNode = existing.nodes.find((n) => n.id === e.to);
          if (!fileNode?.path) return null;
          return {
            path: fileNode.path,
            status: (e.kind === "created" ? "created" : "modified") as "created" | "modified",
          };
        })
        .filter((d): d is { path: string; status: "created" | "modified" } => d !== null);
      priorSummaries.push({
        runId: node.runId,
        preset: node.preset,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        stopReason: node.stopReason,
        deliverables: deliverables.length > 0 ? deliverables : undefined,
      });
    }
  }

  return buildFromSummaries(workspacePath, [...priorSummaries, summary], Date.now());
}