export type ProjectGraphNodeKind =
  | "workspace"
  | "run"
  | "file"
  | "module";

export type ProjectGraphEdgeKind =
  | "run_on_workspace"
  | "created"
  | "modified"
  | "depends_on";

export interface ProjectGraphNode {
  id: string;
  kind: ProjectGraphNodeKind;
  label: string;
  runId?: string;
  preset?: string;
  stopReason?: string;
  startedAt?: number;
  endedAt?: number;
  path?: string;
  status?: "created" | "modified";
}

export interface ProjectGraphEdge {
  from: string;
  to: string;
  kind: ProjectGraphEdgeKind;
}

export interface ProjectGraphHotFile {
  path: string;
  runCount: number;
  lastRunId?: string;
  lastStartedAt?: number;
}

export interface ProjectGraphAnchors {
  missionFiles: string[];
  hotFiles: ProjectGraphHotFile[];
}

export interface ProjectGraphStats {
  runCount: number;
  fileCount: number;
  edgeCount: number;
}

export interface GitCommitEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitHistoryLayer {
  updatedAt: number;
  commits: GitCommitEntry[];
}

export interface StructureModule {
  path: string;
  fileCount: number;
}

export interface StructureEdge {
  from: string;
  to: string;
}

export interface StructureLayer {
  updatedAt: number;
  modules: StructureModule[];
  edges: StructureEdge[];
  scannedFiles: number;
}

export interface ProjectGraph {
  version: 1;
  workspacePath: string;
  updatedAt: number;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  anchors: ProjectGraphAnchors;
  stats: ProjectGraphStats;
  gitLayer?: GitHistoryLayer;
  structureLayer?: StructureLayer;
}

export interface ProjectGraphBrainInsights {
  overTouchedFiles: Array<{ path: string; runCount: number }>;
  suggestedScope: string[];
  summaryLines: string[];
}

/** Minimal summary fields needed to build or merge the graph. */
export interface GraphRunSummary {
  runId?: string;
  preset?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  localPath?: string;
  filesChanged?: number;
  deliverables?: Array<{ path: string; status: "created" | "modified" }>;
  finalGitStatus?: string;
}

export interface ProjectGraphInsights {
  summaryLines: string[];
  overTouchedFiles: Array<{ path: string; runCount: number }>;
  suggestedScope: string[];
}

export interface ProjectGraphApiResponse {
  workspacePath: string;
  graph: Pick<ProjectGraph, "nodes" | "edges" | "anchors" | "stats">;
  gitLayer?: GitHistoryLayer;
  structureLayer?: StructureLayer;
  insights?: ProjectGraphInsights;
  activeRunId?: string;
  source: "sidecar" | "rebuilt";
  stale: boolean;
  updatedAt: number;
}