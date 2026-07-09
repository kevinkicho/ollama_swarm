import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeFileAtomic } from "../swarm/blackboard/writeFileAtomic.js";
import type { ProjectGraph } from "./types.js";

export const PROJECT_GRAPH_RELATIVE = ".swarm/project-graph.json";

export function projectGraphSidecarPath(clonePath: string): string {
  return path.join(clonePath, PROJECT_GRAPH_RELATIVE);
}

export async function readProjectGraphSidecar(clonePath: string): Promise<ProjectGraph | null> {
  const p = projectGraphSidecarPath(clonePath);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw) as ProjectGraph;
    if (parsed?.version !== 1 || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeProjectGraphSidecar(clonePath: string, graph: ProjectGraph): Promise<void> {
  const p = projectGraphSidecarPath(clonePath);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFileAtomic(p, JSON.stringify(graph, null, 2));
}