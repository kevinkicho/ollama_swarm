/**
 * Detailed list view for Setup "Recent runs" (replaces chip strip).
 * Click row → full form refill. View → /runs/:id when runId present.
 */

import { useNavigate } from "react-router-dom";
import {
  formatRecentRunAgo,
  recentRunFlagLabels,
  recentRunWorkspaceLabel,
  type RecentRun,
} from "./RecentRuns";

export function RecentRunsList({
  runs,
  onSelect,
  onRemove,
}: {
  runs: RecentRun[];
  onSelect: (r: RecentRun) => void;
  onRemove?: (r: RecentRun) => void;
}) {
  const navigate = useNavigate();
  if (runs.length === 0) return null;

  return (
    <div className="rounded border border-ink-700 overflow-hidden">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 px-2.5 py-1.5 text-[9px] uppercase tracking-wider text-ink-500 bg-ink-900/60 border-b border-ink-700">
        <span>Workspace / directive</span>
        <span className="text-right">Preset · model</span>
        <span className="text-right w-16">When</span>
      </div>
      <ul className="divide-y divide-ink-800 max-h-72 overflow-y-auto">
        {runs.map((r) => {
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
      <div className="px-2.5 py-1 text-[9px] text-ink-600 border-t border-ink-800">
        Click a row to refill the form (workspace, directive, topology, MCP, models, flags).
        Stored in this browser only.
      </div>
    </div>
  );
}
