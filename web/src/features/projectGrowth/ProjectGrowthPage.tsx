import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

interface ProjectGraphNode {
  id: string;
  kind: "workspace" | "run" | "file";
  label: string;
  runId?: string;
  preset?: string;
  stopReason?: string;
  startedAt?: number;
  endedAt?: number;
  path?: string;
  status?: "created" | "modified";
}

interface ProjectGraphEdge {
  from: string;
  to: string;
  kind: "run_on_workspace" | "created" | "modified";
}

interface GitCommitEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface StructureLayer {
  modules: Array<{ path: string; fileCount: number }>;
  edges: Array<{ from: string; to: string }>;
  scannedFiles: number;
}

interface ProjectGraphInsights {
  summaryLines: string[];
  overTouchedFiles: Array<{ path: string; runCount: number }>;
  suggestedScope: string[];
}

interface ProjectGraphResponse {
  workspacePath: string;
  graph: {
    nodes: ProjectGraphNode[];
    edges: ProjectGraphEdge[];
    anchors: {
      missionFiles: string[];
      hotFiles: Array<{ path: string; runCount: number; lastRunId?: string }>;
    };
    stats: { runCount: number; fileCount: number; edgeCount: number };
  };
  gitLayer?: { updatedAt: number; commits: GitCommitEntry[] };
  structureLayer?: StructureLayer;
  insights?: ProjectGraphInsights;
  source: "sidecar" | "rebuilt";
  stale: boolean;
  updatedAt: number;
}

type TimelineView = "swarm" | "git";

function stopReasonColor(reason?: string): string {
  if (reason === "completed") return "bg-emerald-600";
  if (reason === "stopped" || reason === "user-stop") return "bg-amber-600";
  if (reason === "failed" || reason === "crashed") return "bg-rose-600";
  return "bg-ink-600";
}

export function ProjectGrowthPage({ parentPath }: { parentPath?: string }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pathParam = searchParams.get("path") || parentPath || "";
  const [data, setData] = useState<ProjectGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [timelineView, setTimelineView] = useState<TimelineView>("swarm");
  const [showStructure, setShowStructure] = useState(false);

  const loadGraph = async (opts?: { refreshLayers?: boolean; refreshGraph?: boolean }) => {
    if (!pathParam) {
      setData(null);
      setError("No workspace path — open from an active run or add ?path=");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (pathParam.includes("\\") || pathParam.includes("/")) {
        q.set("clonePath", pathParam);
      } else {
        q.set("parentPath", pathParam);
      }
      q.set("includeGit", "true");
      if (showStructure) q.set("includeStructure", "true");
      if (opts?.refreshLayers) q.set("refreshLayers", "true");
      if (opts?.refreshLayers || opts?.refreshGraph) q.set("refresh", "true");
      const res = await fetch(`/api/swarm/project-graph?${q.toString()}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
      const json = (await res.json()) as ProjectGraphResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGraph(showStructure ? { refreshLayers: true } : undefined);
  }, [pathParam, showStructure]);

  const runNodes = useMemo(
    () =>
      (data?.graph.nodes.filter((n) => n.kind === "run") ?? []).sort(
        (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
      ),
    [data],
  );

  const maxDeliverables = useMemo(() => {
    if (!data) return 1;
    let max = 1;
    for (const r of runNodes) {
      const count = data.graph.edges.filter((e) => e.from === r.id && e.kind !== "run_on_workspace").length;
      if (count > max) max = count;
    }
    return max;
  }, [data, runNodes]);

  const fileRows = useMemo(() => {
    if (!data) return [];
    const byPath = new Map<string, { path: string; runs: string[]; lastStatus?: string }>();
    for (const e of data.graph.edges) {
      if (e.kind !== "created" && e.kind !== "modified") continue;
      const fileNode = data.graph.nodes.find((n) => n.id === e.to);
      if (!fileNode?.path) continue;
      const runNode = data.graph.nodes.find((n) => n.id === e.from);
      const entry = byPath.get(fileNode.path) ?? { path: fileNode.path, runs: [] };
      if (runNode?.runId && !entry.runs.includes(runNode.runId)) entry.runs.push(runNode.runId);
      entry.lastStatus = e.kind;
      byPath.set(fileNode.path, entry);
    }
    return [...byPath.values()].sort((a, b) => b.runs.length - a.runs.length);
  }, [data]);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-ink-200">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-sm font-semibold text-ink-100">Project growth</h1>
          <p className="text-[10px] text-ink-500 mt-0.5 font-mono truncate max-w-xl" title={data?.workspacePath ?? pathParam}>
            {data?.workspacePath ?? pathParam}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadGraph({ refreshLayers: true, refreshGraph: true })}
            className="text-[10px] px-2 py-1 rounded border border-ink-600 hover:bg-ink-700 text-ink-400"
          >
            Refresh layers
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-[10px] px-2 py-1 rounded border border-ink-600 hover:bg-ink-700"
          >
            Back
          </button>
        </div>
      </div>

      {loading ? <p className="text-[11px] text-ink-500">Loading graph…</p> : null}
      {error ? <p className="text-[11px] text-rose-400">{error}</p> : null}

      {data ? (
        <>
          <div className="flex flex-wrap gap-3 text-[10px]">
            <Stat label="Runs" value={String(data.graph.stats.runCount)} />
            <Stat label="Files" value={String(data.graph.stats.fileCount)} />
            <Stat label="Source" value={data.source} />
            {data.stale ? <span className="text-amber-400">Sidecar may be stale — refresh after latest run</span> : null}
          </div>

          <p className="text-[9px] text-ink-500 -mt-2">
            Workspace-scoped history — same clone shows one cumulative graph; bar height reflects files each run touched.
          </p>

          {data.graph.stats.fileCount === 0 && data.graph.stats.runCount > 0 ? (
            <p className="text-[10px] text-amber-300/90 rounded border border-amber-800/40 bg-amber-950/20 px-2 py-1.5">
              File map is empty — usually means summaries lacked deliverables (committed work + clean git status).
              New runs derive deliverables from commit history; click Refresh layers to rebuild.
            </p>
          ) : null}

          {data.insights && data.insights.summaryLines.length > 0 ? (
            <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
              <h2 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">Project analysis</h2>
              <ul className="space-y-1 text-[10px] text-ink-300 leading-snug">
                {data.insights.summaryLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {data.insights.overTouchedFiles.length > 0 ? (
                <ul className="mt-2 text-[9px] font-mono text-ink-400 space-y-0.5">
                  {data.insights.overTouchedFiles.map((f) => (
                    <li key={f.path}>{f.path} — {f.runCount} runs</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-[10px] uppercase tracking-wider text-ink-500">Timeline</h2>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setTimelineView("swarm")}
                  className={`text-[9px] px-2 py-0.5 rounded ${timelineView === "swarm" ? "bg-ink-600 text-ink-200" : "text-ink-500 hover:text-ink-300"}`}
                >
                  Swarm runs
                </button>
                <button
                  type="button"
                  onClick={() => setTimelineView("git")}
                  className={`text-[9px] px-2 py-0.5 rounded ${timelineView === "git" ? "bg-ink-600 text-ink-200" : "text-ink-500 hover:text-ink-300"}`}
                >
                  Git commits
                </button>
              </div>
            </div>
            {timelineView === "swarm" ? (
              <>
                <div className="flex items-end gap-1 min-h-[4rem] overflow-x-auto pb-1">
                  {runNodes.map((r) => {
                    const touchCount = data.graph.edges.filter(
                      (e) => e.from === r.id && (e.kind === "created" || e.kind === "modified"),
                    ).length;
                    const h = Math.max(12, Math.round((touchCount / maxDeliverables) * 48));
                    return (
                      <button
                        key={r.id}
                        type="button"
                        title={`${r.runId} · ${r.stopReason ?? "unknown"} · ${touchCount} files`}
                        onClick={() => r.runId && navigate(`/runs/${encodeURIComponent(r.runId)}`)}
                        className={`shrink-0 w-8 rounded-t ${stopReasonColor(r.stopReason)} hover:opacity-80 transition-opacity`}
                        style={{ height: `${h}px` }}
                      />
                    );
                  })}
                  {runNodes.length === 0 ? (
                    <span className="text-[10px] text-ink-500">No runs with summaries yet.</span>
                  ) : null}
                </div>
                <div className="flex gap-3 mt-2 text-[9px] text-ink-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-600" /> completed</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-600" /> stopped</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-rose-600" /> failed</span>
                </div>
              </>
            ) : data.gitLayer && data.gitLayer.commits.length > 0 ? (
              <ul className="space-y-2 max-h-64 overflow-y-auto">
                {[...data.gitLayer.commits].reverse().map((c) => (
                  <li key={c.hash} className="text-[10px] border-b border-ink-800/50 pb-1">
                    <div className="font-mono text-sky-300/90">{c.hash}</div>
                    <div className="text-ink-300 truncate" title={c.message}>{c.message}</div>
                    <div className="text-ink-500">
                      {c.date.slice(0, 10)} · {c.filesChanged} files · +{c.insertions}/-{c.deletions}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10px] text-ink-500">No git history (not a repo or layer disabled). Try Refresh layers.</p>
            )}
          </section>

          <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] uppercase tracking-wider text-ink-500">Code structure</h2>
              <button
                type="button"
                onClick={() => setShowStructure((v) => !v)}
                className="text-[9px] px-2 py-0.5 rounded border border-ink-600 text-ink-400 hover:bg-ink-700"
              >
                {showStructure ? "Loaded" : "Load import graph"}
              </button>
            </div>
            {data.structureLayer && data.structureLayer.modules.length > 0 ? (
              <>
                <p className="text-[9px] text-ink-500 mb-2">
                  Scanned {data.structureLayer.scannedFiles} files · {data.structureLayer.edges.length} module edges
                </p>
                <ul className="space-y-1 mb-3">
                  {data.structureLayer.modules.slice(0, 15).map((m) => (
                    <li key={m.path} className="text-[10px] font-mono flex justify-between">
                      <span>{m.path}</span>
                      <span className="text-ink-500">{m.fileCount} files</span>
                    </li>
                  ))}
                </ul>
                {data.structureLayer.edges.length > 0 ? (
                  <ul className="text-[9px] text-ink-500 space-y-0.5 max-h-32 overflow-y-auto">
                    {data.structureLayer.edges.slice(0, 20).map((e) => (
                      <li key={`${e.from}-${e.to}`} className="font-mono">{e.from} → {e.to}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-[10px] text-ink-500">
                {showStructure
                  ? "No structure layer yet — click Refresh layers to scan imports (or set PROJECT_GRAPH_STRUCTURE_LAYER=true for auto-refresh)."
                  : "Optional import-based module map (enable via Load)."}
              </p>
            )}
          </section>

          <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
            <h2 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">Hot files (cross-run)</h2>
            {data.graph.anchors.hotFiles.length === 0 ? (
              <p className="text-[10px] text-ink-500">No deliverables recorded yet.</p>
            ) : (
              <ul className="space-y-1">
                {data.graph.anchors.hotFiles.map((f) => (
                  <li key={f.path} className="text-[10px] font-mono flex justify-between gap-2">
                    <span className="truncate">{f.path}</span>
                    <span className="text-ink-500 shrink-0">{f.runCount} run{f.runCount === 1 ? "" : "s"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
            <h2 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">Run ↔ file map</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-ink-500 text-left border-b border-ink-700">
                    <th className="py-1 pr-2">File</th>
                    <th className="py-1 pr-2">Runs</th>
                    <th className="py-1">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {fileRows.slice(0, 40).map((row) => (
                    <tr key={row.path} className="border-b border-ink-800/60">
                      <td className="py-1 pr-2 font-mono truncate max-w-[16rem]" title={row.path}>{row.path}</td>
                      <td className="py-1 pr-2 text-ink-400">{row.runs.length}</td>
                      <td className="py-1 text-ink-500">{row.lastStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-ink-700 px-2 py-1 bg-ink-950/40">
      <span className="text-ink-500">{label}: </span>
      <span className="font-mono text-ink-300">{value}</span>
    </div>
  );
}