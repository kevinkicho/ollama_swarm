import type { ProjectGraph } from "./types.js";

export const DEFAULT_AGENT_SLICE_MAX_CHARS = 1500;
export const DEFAULT_PLANNER_SLICE_MAX_CHARS = 3000;

/** Token-bounded prompt block for planner/worker grounding. */
export function formatAgentSlice(
  graph: ProjectGraph,
  opts?: { maxChars?: number; runDeliverables?: Array<{ path: string; status: string }> },
): string {
  const maxChars = opts?.maxChars ?? DEFAULT_AGENT_SLICE_MAX_CHARS;
  const lines: string[] = [
    "## Project map (swarm knowledge graph)",
    `Workspace: ${graph.workspacePath}`,
  ];

  if (graph.anchors.missionFiles.length > 0) {
    lines.push(`Mission anchors: ${graph.anchors.missionFiles.join(", ")}`);
  }

  if (graph.anchors.hotFiles.length > 0) {
    const hot = graph.anchors.hotFiles
      .slice(0, 8)
      .map((h) => `${h.path} (${h.runCount} run${h.runCount === 1 ? "" : "s"})`)
      .join(", ");
    lines.push(`Recently active files (cross-run): ${hot}`);
  }

  if (graph.structureLayer && graph.structureLayer.modules.length > 0) {
    const mods = graph.structureLayer.modules
      .slice(0, 6)
      .map((m) => m.path)
      .join(", ");
    lines.push(`Code modules (import graph): ${mods}`);
  }

  if (opts?.runDeliverables && opts.runDeliverables.length > 0) {
    const scope = opts.runDeliverables
      .slice(0, 12)
      .map((d) => `${d.status} ${d.path}`)
      .join("; ");
    lines.push(`This run's scope so far: ${scope}`);
  }

  const runNodes = graph.nodes
    .filter((n) => n.kind === "run")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 3);
  for (const r of runNodes) {
    const fileEdges = graph.edges.filter((e) => e.from === r.id && e.kind !== "run_on_workspace");
    if (fileEdges.length === 0) continue;
    const paths = fileEdges
      .map((e) => graph.nodes.find((n) => n.id === e.to)?.path)
      .filter((p): p is string => !!p)
      .slice(0, 4)
      .join(", ");
    lines.push(`Prior run ${r.runId?.slice(0, 8)}: touched ${paths}`);
  }

  lines.push(
    "Stay within the user directive AND prefer extending existing modules over new islands.",
    "If exploring new areas, link changes back to mission anchors before finishing.",
  );

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1) + "…";
  }
  return text;
}