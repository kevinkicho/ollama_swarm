import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTopbarDropdown } from "../../lib/topbarDropdown";
import type { RunSummaryDigest } from "../../types";
import { copyText } from "../../utils/copyText";
import { truncateLeft } from "../IdentityStrip";
import { loadRecentRuns, type RecentRun } from "../setup/RecentRuns";
import { apiFetch } from "../../lib/apiFetch";
import {
  cacheRunsList,
  cachedRunsList,
  RUN_SUMMARY_PAGE_SIZE,
} from "./runHistoryCache";
import {
  formatDurationCompact,
  fmtTimeShort,
  PresetChip,
  ResultChip,
  TopologyChip,
} from "./runHistoryFormat";
import { RunsAggregateDashboard } from "./RunsAggregateDashboard";
import { RunDigestModal } from "./RunDigestModal";

export function RunHistoryDropdown({ parentPath, forceOpenSignal }: { parentPath?: string; forceOpenSignal?: number } = {}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummaryDigest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Task #111: track whether the current `runs` came from the cache
  // (server unreachable) so the dropdown can render a "[cached]" badge.
  const [fromCache, setFromCache] = useState(false);
  const [selected, setSelected] = useState<RunSummaryDigest | null>(null);
  // New: optional merge of client-side "Recent runs" (localStorage) into the server list
  const [includeLocalRecent, setIncludeLocalRecent] = useState(false);
  const [localRecent, setLocalRecent] = useState<RecentRun[]>([]);
  const [page, setPage] = useState(0);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeDropdown = useCallback(() => setOpen(false), []);
  const { panelRef, pos: panelPos, panelStyle } = useTopbarDropdown(open, triggerRef, 960, closeDropdown);

  // Refetch on open so the list reflects any sibling runs that
  // appeared since the previous open. Cheap — directory listing.
  // Task #47: retry on TypeError: Failed to fetch so tsx-watch restart
  // windows don't surface as a permanent error in the dropdown.
  // Task #111: on network failure after retries, fall back to the
  // localStorage cache so users can still browse prior runs even
  // when the dev server is offline.
  // Only force-open when the signal is explicitly incremented (e.g. from QuickNav "History" button).
  // Do NOT open on initial value (0) or every render — that was causing the dropdown
  // to auto-appear without user click, blocking views and screenshots.
  const prevForceRef = React.useRef<number | undefined>(undefined);
  useEffect(() => {
    if (forceOpenSignal !== undefined && forceOpenSignal !== prevForceRef.current) {
      if (forceOpenSignal > 0) {
        setOpen(true);
      }
      prevForceRef.current = forceOpenSignal;
    }
  }, [forceOpenSignal]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setFromCache(false);
    // Load local recent (client cache) so we can optionally merge
    setLocalRecent(loadRecentRuns());
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const params = new URLSearchParams();
          if (parentPath) params.set("parentPath", parentPath);
          // Always include other parents for the topbar "Runs" dropdown so it
          // discovers runs from yesterday / other workspaces (recent runs card
          // uses localStorage; this uses server FS scan of summaries).
          params.set("includeOtherParents", "true");
          const r = await apiFetch(`/api/swarm/runs?${params}`, { signal: ctrl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.json();
          if (cancelled) return;
          const list = Array.isArray(body.runs) ? (body.runs as RunSummaryDigest[]) : [];
          setRuns(list);
          cacheRunsList(list);
          setLoading(false);
          return;
        } catch (err) {
          const isNetwork = err instanceof TypeError;
          if (!isNetwork || attempt === 2) {
            if (!cancelled) {
              // Task #111: offline fallback.
              const cached = cachedRunsList();
              if (cached && cached.length > 0) {
                setRuns(cached);
                setFromCache(true);
                setError(null);
              } else {
                setError(err instanceof Error ? err.message : String(err));
              }
              setLoading(false);
            }
            return;
          }
          await new Promise((r2) => setTimeout(r2, 500));
        }
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [open, parentPath]);

  // Merge server runs + optional local recent runs (mapped to digest shape for display)
  const displayedRuns: RunSummaryDigest[] = React.useMemo(() => {
    const server = runs || [];
    if (!includeLocalRecent || localRecent.length === 0) return server;
    const localMapped: RunSummaryDigest[] = localRecent.map((r) => ({
      name: r.repoUrl?.split(/[/\\]/).pop() || 'recent',
      clonePath: r.parentPath || (r as any).clonePath || '',
      preset: r.presetId || 'unknown',
      model: (r as any).model || '',
      startedAt: r.startedAt || Date.now(),
      endedAt: (r as any).endedAt || 0,
      wallClockMs: (r as any).wallClockMs || 0,
      stopReason: (r as any).stopReason,
      commits: 0,
      totalTodos: 0,
      hasContract: false,
      isActive: false,
      runId: r.runId,
      topology: (r as any).topology,
    } as RunSummaryDigest));
    // dedupe by runId or clonePath+startedAt
    const seen = new Set<string>();
    const merged: RunSummaryDigest[] = [];
    for (const d of [...server, ...localMapped]) {
      const key = d.runId || `${d.clonePath}:${d.startedAt}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(d);
      }
    }
    return merged.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }, [runs, includeLocalRecent, localRecent]);

  const totalPages = Math.max(1, Math.ceil(displayedRuns.length / RUN_SUMMARY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * RUN_SUMMARY_PAGE_SIZE;
  const pageItems = displayedRuns.slice(pageStart, pageStart + RUN_SUMMARY_PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [displayedRuns.length, includeLocalRecent, open]);

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  const dropdownPanel =
    open && panelPos ? (
      <div
        ref={panelRef}
        className="fixed z-50 rounded border border-ink-600 bg-ink-900 shadow-xl shadow-black/50 overflow-hidden"
        style={panelStyle}
      >
          <div className="px-3 py-2 border-b border-ink-700 flex items-center justify-between text-[11px] text-ink-400">
            <span>
              <span className="text-emerald-400 font-semibold">Run Summaries</span>
              <span className="ml-2 text-ink-500">— curated results from summary files</span>
              {displayedRuns.length > 0 ? <span className="ml-2 text-ink-500">({displayedRuns.length})</span> : null}
              {/* Task #111: badge when viewing cached data (server unreachable). */}
              {fromCache ? (
                <span
                  className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-300"
                  title="Server unreachable — showing localStorage cache. Reopen the dropdown to retry."
                >
                  cached · server offline
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setIncludeLocalRecent(v => !v)}
                className={`ml-2 text-[10px] px-1.5 py-0.5 rounded border transition ${includeLocalRecent ? 'bg-emerald-900/50 border-emerald-700 text-emerald-200' : 'bg-ink-800 border-ink-700 text-ink-400 hover:text-ink-200'}`}
                title="Merge client-side Recent Runs (from localStorage in the setup form) into this server-scanned list"
              >
                {includeLocalRecent ? '✓ recent' : '+ recent'}
              </button>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {displayedRuns.length > RUN_SUMMARY_PAGE_SIZE ? (
                <span className="flex items-center gap-1 text-[10px] text-ink-500">
                  <button
                    type="button"
                    disabled={safePage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="px-1 py-0 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40 disabled:hover:text-ink-400"
                    aria-label="Previous page"
                  >
                    ←
                  </button>
                  <span className="tabular-nums whitespace-nowrap">
                    {safePage + 1}/{totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    className="px-1 py-0 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40 disabled:hover:text-ink-400"
                    aria-label="Next page"
                  >
                    →
                  </button>
                </span>
              ) : null}
              <button
                onClick={() => setOpen(false)}
                className="text-ink-500 hover:text-ink-200"
                aria-label="Close"
              >
                ✕
              </button>
            </span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {loading ? (
              <div className="p-3 text-ink-400">Loading…</div>
            ) : error ? (
              <div className="p-3 text-red-300">Failed to load: {error}</div>
            ) : displayedRuns.length === 0 ? (
              <div className="p-3 text-ink-400 italic">
                No run summaries found. (Recent runs in setup use local cache; server scan looks for summary-*.json under parent/logs.)
              </div>
            ) : runs ? (
              <>
                {/* #313 (2026-04-28): aggregate dashboard. Computed
                    client-side from the same runs data — no extra fetch.
                    Surfaces preset-level reliability + cost trends so
                    users see "council always passes, blackboard
                    flaky" without scrolling 95 individual rows. */}
                <RunsAggregateDashboard runs={runs} />
                {/* Task #86 (2026-04-25): spreadsheet-style table with
                    aligned columns + color-coded preset/result chips so
                    users can scan the history at a glance. */}
                <table className="w-full text-[11px] font-mono">
                <thead className="bg-ink-800/60 text-ink-500 text-left text-[10px] uppercase tracking-wider sticky top-0 z-10">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Time</th>
                    <th className="px-2 py-1.5 font-semibold">Run</th>
                    <th className="px-2 py-1.5 font-semibold">Preset</th>
                    <th className="px-2 py-1.5 font-semibold">Result</th>
                    <th
                      className="px-2 py-1.5 font-semibold"
                      title="Phase 4a of #243: agent topology used for this run (e.g. 1P · 4W · 1A means 1 planner + 4 workers + 1 auditor)."
                    >
                      Topology
                    </th>
                    <th className="px-2 py-1.5 font-semibold text-right">Commits</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Todos</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Wall</th>
                    <th className="px-2 py-1.5 font-semibold">Path</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((r) => (
                    <tr
                      key={`${r.clonePath}-${r.runId ?? r.startedAt}`}
                      className={
                        "border-t border-ink-800/60 hover:bg-ink-800/40 transition cursor-pointer " +
                        (r.isActive ? "bg-emerald-900/20" : "")
                      }
                      onClick={() => setSelected(r)}
                    >
                      <td className="px-2 py-1 text-ink-400" title={new Date(r.startedAt).toLocaleString()}>
                        {fmtTimeShort(r.startedAt)}
                      </td>
                      <td className="px-2 py-1">
                        {r.runId ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void copyText(r.runId!);
                            }}
                            title={`Copy full runId: ${r.runId}`}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700 hover:text-ink-100 text-ink-300"
                          >
                            {r.runId.slice(0, 8)}
                          </button>
                        ) : (
                          <span className="text-ink-600 text-[10px]">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <PresetChip preset={r.preset} />
                      </td>
                      <td className="px-2 py-1">
                        {r.isActive ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700/30 border border-emerald-600/40 text-emerald-300 font-semibold">
                            ● ACTIVE
                          </span>
                        ) : r.stopReason ? (
                          <ResultChip reason={r.stopReason} />
                        ) : (
                          <span className="text-ink-600 text-[10px]">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <TopologyChip topology={r.topology} />
                      </td>
                      {/* 2026-04-25 fine-tune (Kevin): empty / zero values show
                          "—" at 0.5 opacity so the columns stay visually anchored
                          but the eye knows it's "no data" not a real zero. */}
                      <td className="px-2 py-1 text-right tabular-nums">
                        {r.commits && r.commits > 0 ? (
                          <span className="text-ink-300">{r.commits}</span>
                        ) : (
                          <span className="text-ink-400 opacity-50">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {r.totalTodos && r.totalTodos > 0 ? (
                          <span className="text-ink-300">{r.totalTodos}</span>
                        ) : (
                          <span className="text-ink-400 opacity-50">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                        {r.wallClockMs > 0 ? (
                          <span className="text-ink-300">{formatDurationCompact(r.wallClockMs)}</span>
                        ) : (
                          <span className="text-ink-400 opacity-50">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-ink-500 truncate max-w-[260px]" title={r.clonePath}>
                        {truncateLeft(r.clonePath, 36)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {displayedRuns.length > RUN_SUMMARY_PAGE_SIZE ? (
                <div className="flex items-center justify-between px-3 py-2 border-t border-ink-800/80 text-[10px] text-ink-500">
                  <button
                    type="button"
                    disabled={safePage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="px-1.5 py-0.5 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40"
                  >
                    ← prev
                  </button>
                  <span className="tabular-nums">
                    {pageStart + 1}–{Math.min(pageStart + RUN_SUMMARY_PAGE_SIZE, displayedRuns.length)} of{" "}
                    {displayedRuns.length}
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    className="px-1.5 py-0.5 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40"
                  >
                    next →
                  </button>
                </div>
              ) : null}
              </>
            ) : null}
          </div>
        </div>
    ) : null;

  return (
    <span ref={triggerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Browse past runs — curated summary data (commits, todos, duration)"
        className="text-[11px] uppercase tracking-wide px-2 py-1 rounded bg-emerald-900/40 hover:bg-emerald-800/50 text-emerald-300 border border-emerald-700/50 hover:border-emerald-600 transition"
      >
        ▸ Runs{displayedRuns.length > 0 ? ` (${displayedRuns.length})` : ""}
      </button>
      {dropdownPanel ? createPortal(dropdownPanel, document.body) : null}
      {selected ? (
        <RunDigestModal digest={selected} onClose={() => setSelected(null)} />
      ) : null}
    </span>
  );
}

