import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../../lib/apiFetch";

type ProjectGraphResponse = {
  workspacePath: string;
  graph: {
    nodes: Array<{ id: string; kind: string; label: string; runId?: string; stopReason?: string; startedAt?: number }>;
    edges: Array<{ from: string; to: string; kind: string }>;
    anchors: { hotFiles: Array<{ path: string; runCount: number }> };
    stats: { runCount: number; fileCount: number };
  };
  insights?: {
    summaryLines: string[];
    overTouchedFiles: Array<{ path: string; runCount: number }>;
    suggestedScope: string[];
  };
  activeRunId?: string;
  source: "sidecar" | "rebuilt";
  stale: boolean;
};

function stopReasonColor(reason?: string): string {
  if (reason === "completed") return "bg-emerald-600";
  if (reason === "stopped" || reason === "user-stop" || reason === "user") return "bg-amber-600";
  if (reason === "failed" || reason === "crashed" || reason === "crash") return "bg-rose-600";
  return "bg-ink-600";
}

export function ProjectGraphPanel({
  clonePath,
  activeRunId,
}: {
  clonePath?: string;
  activeRunId?: string;
}) {
  const [data, setData] = useState<ProjectGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (refresh = false) => {
      if (!clonePath?.trim()) {
        setData(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({ clonePath, includeGit: "true" });
      if (refresh) q.set("refresh", "true");
      void apiFetch(`/api/swarm/project-graph?${q}`)
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
          }
          return res.json() as Promise<ProjectGraphResponse>;
        })
        .then((json) => setData(json))
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          setData(null);
        })
        .finally(() => setLoading(false));
    },
    [clonePath],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const runNodes = useMemo(
    () =>
      (data?.graph.nodes.filter((n) => n.kind === "run") ?? []).sort(
        (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
      ),
    [data],
  );

  const maxTouch = useMemo(() => {
    let max = 1;
    if (!data) return max;
    for (const r of runNodes) {
      const touch = data.graph.edges.filter(
        (e) => e.from === r.id && e.kind !== "run_on_workspace",
      ).length;
      if (touch > max) max = touch;
    }
    return max;
  }, [data, runNodes]);

  const emptyFiles = data != null && data.graph.stats.fileCount === 0 && data.graph.stats.runCount > 0;

  if (!clonePath?.trim()) {
    return (
      <p className="text-[11px] text-ink-500 p-4">
        No clone path on this run — project graph needs a workspace clone.
      </p>
    );
  }

  return (
    <div className="p-4 space-y-4 text-ink-200 overflow-y-auto h-full">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Project knowledge graph</h2>
          <p className="text-[10px] text-ink-500 font-mono truncate max-w-lg" title={data?.workspacePath ?? clonePath}>
            {data?.workspacePath ?? clonePath}
          </p>
          <p className="text-[9px] text-ink-500 mt-0.5">
            Cumulative across all runs on this workspace — not per-run only.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => load(true)}
            className="text-[10px] px-2 py-1 rounded border border-ink-600 hover:bg-ink-700 text-ink-400"
          >
            Refresh
          </button>
          <Link
            to={`/growth?path=${encodeURIComponent(clonePath)}`}
            className="text-[10px] px-2 py-1 rounded border border-ink-600 text-sky-300/90 hover:bg-ink-700"
          >
            Full growth view →
          </Link>
        </div>
      </div>

      {loading ? <p className="text-[11px] text-ink-500">Loading graph…</p> : null}
      {error ? <p className="text-[11px] text-rose-400">{error}</p> : null}

      {data ? (
        <>
          <div className="flex flex-wrap gap-3 text-[10px]">
            <span className="text-ink-500">Runs: <span className="text-ink-300 font-mono">{data.graph.stats.runCount}</span></span>
            <span className="text-ink-500">Files: <span className="text-ink-300 font-mono">{data.graph.stats.fileCount}</span></span>
            <span className="text-ink-500">Source: <span className="text-ink-300">{data.source}</span></span>
            {data.stale ? <span className="text-amber-400">Sidecar stale — click Refresh after run ends</span> : null}
          </div>

          {emptyFiles ? (
            <p className="text-[10px] text-amber-300/90 rounded border border-amber-800/40 bg-amber-950/20 px-2 py-1.5 leading-snug">
              Runs are recorded but no file touches yet. Blackboard runs that commit during the run often have
              empty git status at end — deliverables are now derived from commit history on new summaries.
              Re-run Refresh after the current run finishes, or backfill from completed summaries.
            </p>
          ) : null}

          {data.insights && data.insights.summaryLines.length > 0 ? (
            <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
              <h3 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">Analysis</h3>
              <ul className="space-y-1 text-[10px] text-ink-300 leading-snug">
                {data.insights.summaryLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {data.insights.suggestedScope.length > 0 ? (
                <p className="text-[9px] text-sky-300/80 mt-2 font-mono">
                  Suggested scope: {data.insights.suggestedScope.join(", ")}
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
            <h3 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">Swarm evolution</h3>
            <div className="flex items-end gap-1 min-h-[3rem] overflow-x-auto pb-1">
              {runNodes.map((r) => {
                const touch = data.graph.edges.filter(
                  (e) => e.from === r.id && e.kind !== "run_on_workspace",
                ).length;
                const h = Math.max(12, Math.round((touch / maxTouch) * 48));
                const isActive =
                  (activeRunId && r.runId === activeRunId) ||
                  (data.activeRunId && r.runId === data.activeRunId);
                return (
                  <div
                    key={r.id}
                    title={`${r.runId ?? r.label} · ${r.stopReason ?? "unknown"} · ${touch} files`}
                    className={`shrink-0 w-7 rounded-t ${stopReasonColor(r.stopReason)} ${
                      isActive ? "ring-2 ring-sky-400/80" : ""
                    }`}
                    style={{ height: `${h}px` }}
                  />
                );
              })}
              {runNodes.length === 0 ? (
                <span className="text-[10px] text-ink-500">No completed runs with summaries yet.</span>
              ) : null}
            </div>
            <p className="text-[9px] text-ink-500 mt-1">Bar height = files touched that run · ring = current run (when finished)</p>
          </section>

          <section className="rounded border border-ink-700 bg-ink-900/50 p-3">
            <h3 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">Hot files</h3>
            {data.graph.anchors.hotFiles.length === 0 ? (
              <p className="text-[10px] text-ink-500">No cross-run file touches recorded.</p>
            ) : (
              <ul className="space-y-1 max-h-48 overflow-y-auto">
                {data.graph.anchors.hotFiles.map((f) => (
                  <li key={f.path} className="text-[10px] font-mono flex justify-between gap-2">
                    <span className="truncate">{f.path}</span>
                    <span className="text-ink-500 shrink-0">{f.runCount} runs</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}