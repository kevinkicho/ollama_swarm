import type { ProjectGraph, ProjectGraphBrainInsights } from "./types.js";

/** Rule-based project-graph insights for Brain librarian (PR7). */
export function analyzeProjectGraphForBrain(graph: ProjectGraph): ProjectGraphBrainInsights {
  const overTouchedFiles = (graph.anchors.hotFiles ?? [])
    .filter((h) => h.runCount >= 3)
    .slice(0, 8)
    .map((h) => ({ path: h.path, runCount: h.runCount }));

  const hotSet = new Set(graph.anchors.hotFiles.map((h) => h.path));
  const modules = graph.structureLayer?.modules ?? [];
  const underserved = modules
    .filter((m) => m.fileCount >= 3)
    .map((m) => m.path)
    .filter((mod) => ![...hotSet].some((f) => f.startsWith(mod)))
    .slice(0, 5);

  const recentRuns = graph.nodes
    .filter((n) => n.kind === "run")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 5);

  const summaryLines: string[] = [
    `Project graph: ${graph.stats.runCount} swarm runs, ${graph.stats.fileCount} files touched across runs.`,
  ];

  if (overTouchedFiles.length > 0) {
    summaryLines.push(
      `Over-touched files: ${overTouchedFiles.map((f) => `${f.path} (${f.runCount} runs)`).join(", ")}.`,
    );
  }

  if (underserved.length > 0) {
    summaryLines.push(
      `Large modules with little swarm attention: ${underserved.join(", ")}.`,
    );
  }

  if (graph.gitLayer && graph.gitLayer.commits.length > 0) {
    const recent = graph.gitLayer.commits[0];
    summaryLines.push(
      `Latest git commit: ${recent.hash} — "${recent.message.slice(0, 60)}" (${recent.filesChanged} files).`,
    );
  }

  const failedRuns = recentRuns.filter((r) => r.stopReason && r.stopReason !== "completed");
  if (failedRuns.length >= 2) {
    summaryLines.push(
      `${failedRuns.length} of last ${recentRuns.length} runs did not complete — consider narrower scope or different preset.`,
    );
  }

  const suggestedScope = [
    ...underserved.slice(0, 3),
    ...graph.anchors.missionFiles.slice(0, 2),
  ].filter((v, i, a) => a.indexOf(v) === i);

  return { overTouchedFiles, suggestedScope, summaryLines };
}

export function formatGraphContextForBrain(graph: ProjectGraph, insights: ProjectGraphBrainInsights): string {
  const lines = [
    "=== PROJECT KNOWLEDGE GRAPH (cross-run librarian) ===",
    ...insights.summaryLines,
  ];
  if (insights.suggestedScope.length > 0) {
    lines.push(`Suggested next-run scope anchors: ${insights.suggestedScope.join(", ")}`);
  }
  if (graph.structureLayer && graph.structureLayer.modules.length > 0) {
    const top = graph.structureLayer.modules
      .slice(0, 6)
      .map((m) => `${m.path} (${m.fileCount} files)`)
      .join(", ");
    lines.push(`Code modules (import scan): ${top}`);
  }
  lines.push("=== end PROJECT KNOWLEDGE GRAPH ===");
  return lines.join("\n");
}

export function graphInsightsToRunInsights(
  insights: ProjectGraphBrainInsights,
): Array<{
  title: string;
  description: string;
  category: "recommendation" | "followup";
  priority: "high" | "medium" | "low";
}> {
  const out: Array<{
    title: string;
    description: string;
    category: "recommendation" | "followup";
    priority: "high" | "medium" | "low";
  }> = [];

  if (insights.overTouchedFiles.length > 0) {
    const top = insights.overTouchedFiles[0];
    out.push({
      title: "Project graph: files touched repeatedly",
      description: `${top.path} was modified in ${top.runCount} runs. Consider consolidating work there or stabilizing before expanding scope.`,
      category: "recommendation",
      priority: "medium",
    });
  }

  if (insights.suggestedScope.length > 0) {
    out.push({
      title: "Project graph: suggested next scope",
      description: `Under-served or mission areas to target next: ${insights.suggestedScope.join(", ")}.`,
      category: "followup",
      priority: "medium",
    });
  }

  return out;
}