/**
 * Detailed list view for Setup "Recent runs".
 * Page size 5 + prev/next; click row → full form refill.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  formatRecentRunAgo,
  RECENT_RUNS_PAGE_SIZE,
  recentRunFlagLabels,
  recentRunWorkspaceLabel,
  type RecentRun,
} from "./RecentRuns";

export function RecentRunsList({
  runs,
  onSelect,
  onRemove,
  pageSize = RECENT_RUNS_PAGE_SIZE,
}: {
  runs: RecentRun[];
  onSelect: (r: RecentRun) => void;
  onRemove?: (r: RecentRun) => void;
  pageSize?: number;
}) {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(runs.length / size));
  const safePage = Math.min(page, totalPages - 1);

  useEffect(() => {
    setPage(0);
  }, [runs.length]);

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = safePage * size;
    return runs.slice(start, start + size);
  }, [runs, safePage, size]);

  if (runs.length === 0) return null;

  return (
    <div className="rounded border border-ink-700 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-ink-900/60 border-b border-ink-700">
        <span className="text-[9px] uppercase tracking-wider text-ink-500">
          Workspace / directive
        </span>
        <span className="text-[10px] text-ink-500 tabular-nums">
          {runs.length} saved
          {totalPages > 1 ? (
            <span className="ml-1.5">
              · page {safePage + 1}/{totalPages}
            </span>
          ) : null}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 px-2.5 py-1 text-[9px] uppercase tracking-wider text-ink-600 border-b border-ink-800/80">
        <span>Details</span>
        <span className="text-right">Preset · model</span>
        <span className="text-right w-16">When</span>
      </div>
      <ul className="divide-y divide-ink-800">
        {pageItems.map((r) => {
          const workspace = recentRunWorkspaceLabel(r);
          const pathHint = r.parentPath?.trim()
            ? r.parentPath.trim().replace(/\\/g, "/")
            : "";
          const directive =
            r.directiveSnippet?.trim() || r.directive?.trim() || "";
          const model = r.model?.trim() || "—";
          const agents =
            r.agentCount != null
              ? r.agentCount
              : r.topology?.agents?.length ?? null;
          const flags = recentRunFlagLabels(r);
          const ago = formatRecentRunAgo(r.startedAt);
          const runShort = r.runId ? r.runId.slice(0, 8) : null;

          return (
            <li key={r.id || r.runId || String(r.startedAt)} className="group">
              <div className="flex items-stretch gap-0 hover:bg-ink-800/50">
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  className="flex-1 min-w-0 text-left px-2.5 py-2 grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-0.5 items-start"
                  title="Fill the form with this run's saved settings"
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="text-xs font-medium text-ink-100 truncate">
                        {workspace}
                      </span>
                      {runShort ? (
                        <span className="text-[9px] font-mono text-ink-500 shrink-0">
                          {runShort}
                        </span>
                      ) : null}
                    </div>
                    {pathHint && pathHint !== workspace ? (
                      <div className="text-[10px] font-mono text-ink-500 truncate" title={pathHint}>
                        {pathHint}
                      </div>
                    ) : null}
                    {directive ? (
                      <div className="text-[11px] text-ink-300 line-clamp-2 mt-0.5">
                        {directive}
                      </div>
                    ) : (
                      <div className="text-[10px] text-ink-600 italic mt-0.5">
                        (no directive)
                      </div>
                    )}
                    {flags.length > 0 ? (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {flags.map((f) => (
                          <span
                            key={f}
                            className="text-[9px] px-1 py-0 rounded bg-ink-800 border border-ink-700 text-ink-400 font-mono"
                          >
                            {f}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-right shrink-0 max-w-[9rem]">
                    <div className="text-[11px] text-emerald-400/90 font-mono">
                      {r.presetId || "—"}
                    </div>
                    <div className="text-[10px] text-ink-400 font-mono truncate" title={model}>
                      {model}
                    </div>
                    {agents != null ? (
                      <div className="text-[9px] text-ink-500">{agents} agents</div>
                    ) : null}
                  </div>
                  <div className="text-right w-16 shrink-0">
                    <div className="text-[10px] text-ink-400 whitespace-nowrap">{ago}</div>
                  </div>
                </button>
                <div className="flex flex-col justify-center gap-0.5 pr-1.5 py-1 shrink-0 opacity-70 group-hover:opacity-100">
                  {r.runId ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/runs/${encodeURIComponent(r.runId!)}`);
                      }}
                      className="text-[9px] px-1.5 py-0.5 rounded border border-ink-600 text-sky-400 hover:bg-ink-800"
                      title={`Open run ${r.runId}`}
                    >
                      view
                    </button>
                  ) : null}
                  {onRemove ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(r);
                      }}
                      className="text-[9px] px-1.5 py-0.5 rounded border border-ink-700 text-ink-500 hover:text-rose-300 hover:border-rose-800"
                      title="Remove from recent list"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {totalPages > 1 ? (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-t border-ink-800 bg-ink-950/40">
          <button
            type="button"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="text-[10px] px-2 py-0.5 rounded border border-ink-600 text-ink-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ink-800"
          >
            ← Prev
          </button>
          <span className="text-[10px] text-ink-500 tabular-nums">
            Showing {safePage * size + 1}–{Math.min((safePage + 1) * size, runs.length)} of{" "}
            {runs.length}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="text-[10px] px-2 py-0.5 rounded border border-ink-600 text-ink-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ink-800"
          >
            Next →
          </button>
        </div>
      ) : null}
      <div className="px-2.5 py-1 text-[9px] text-ink-600 border-t border-ink-800">
        Click a row to refill the form (workspace, directive, topology, MCP, models, flags).
        {size} per page · stored in this browser only.
      </div>
    </div>
  );
}
