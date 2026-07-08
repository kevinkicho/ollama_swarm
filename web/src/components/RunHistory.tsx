import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTopbarDropdown } from "../lib/topbarDropdown";
import type { PerAgentStat, RunSummary, RunSummaryDigest } from "../types";
import type { AgentRole, Topology } from "../../../shared/src/topology";
import { copyText } from "../utils/copyText";
import { truncateLeft } from "./IdentityStrip";
import { loadRecentRuns, type RecentRun } from "./setup/RecentRuns";
import { AgentStatsTable, rowsFromPerAgentStats } from "./AgentStatsTable";

// Unit 56: IdentifiersRow has been deleted as a separate row.
// - run uuid moved into IdentityStrip's leading chip
// - per-agent session id + model moved into AgentPanel cards
// - history dropdown moved into IdentityStrip's right edge
// Net result: 2 topbars collapsed to 1; agent-scoped info renders
// where you already look for the agent (the sidebar card).

// Unit 52e: lazy-fetches GET /api/runs when opened, lists prior runs
// in the active run's parent dir, click row → modal with the prior
// summary's headline data + Open Folder button (POST /open). Stays
// closed until the user clicks — no eager fetching that would race
// page-load.
// Task #85 (2026-04-25): exported so the App-level top header can
// render the dropdown even before any run has started — users can
// review past runs from the SetupForm flash page without first
// having to start a new run.

// Task #111 (2026-04-25): localStorage cache for the history dropdown
// + run-summary fetches. When the dev server is down (which happens
// often during dev work), the dropdown was empty and prior runs
// weren't browsable. Cache successful responses; fall back on network
// error; surface a "[cached]" badge so users know they're viewing
// stale data.
const CACHE_RUNS_LIST_KEY = "ollama-swarm:runs-list";
const CACHE_RUN_SUMMARY_PREFIX = "ollama-swarm:run-summary:";
const CACHE_RUNS_LIST_MAX = 100;
const CACHE_SUMMARY_MAX_BYTES = 1_000_000; // 1MB per summary
const RUN_SUMMARY_PAGE_SIZE = 10;

function tryReadCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error('[RunHistory] tryReadCache-failed:', err);
    return null;
  }
}
function tryWriteCache(key: string, value: unknown): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > CACHE_SUMMARY_MAX_BYTES) return;
    localStorage.setItem(key, serialized);
  } catch (err) {
    console.error('[RunHistory] tryWriteCache-failed:', err);
    // Quota exceeded or storage disabled — silent fallback. The cache
    // is a nice-to-have, not load-bearing.
  }
}
function cacheRunsList(runs: RunSummaryDigest[]): void {
  tryWriteCache(CACHE_RUNS_LIST_KEY, runs.slice(0, CACHE_RUNS_LIST_MAX));
}
function cachedRunsList(): RunSummaryDigest[] | null {
  return tryReadCache<RunSummaryDigest[]>(CACHE_RUNS_LIST_KEY);
}
function cacheRunSummary(clonePath: string, runId: string | undefined, summary: RunSummary): void {
  const id = runId ?? clonePath;
  tryWriteCache(`${CACHE_RUN_SUMMARY_PREFIX}${id}`, summary);
}
function cachedRunSummary(clonePath: string, runId: string | undefined): RunSummary | null {
  const id = runId ?? clonePath;
  return tryReadCache<RunSummary>(`${CACHE_RUN_SUMMARY_PREFIX}${id}`);
}

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
          const r = await fetch(`/api/swarm/runs?${params}`, { signal: ctrl.signal });
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

// #313: aggregate dashboard rendered at the top of the history
// dropdown. Per-preset rollup of run count, success rate, mean
// wall-clock, and total commits — gives a one-glance view of
// "which presets are reliable" without scrolling individual rows.
function RunsAggregateDashboard({ runs }: { runs: RunSummaryDigest[] }) {
  // Group by preset (collapsing variants with same key)
  const byPreset = new Map<
    string,
    { total: number; completed: number; wallSum: number; wallCount: number; commits: number }
  >();
  for (const r of runs) {
    if (r.isActive) continue; // exclude in-flight from the aggregate
    const existing = byPreset.get(r.preset) ?? { total: 0, completed: 0, wallSum: 0, wallCount: 0, commits: 0 };
    existing.total += 1;
    if (r.stopReason === "completed") existing.completed += 1;
    if (typeof r.wallClockMs === "number" && r.wallClockMs > 0) {
      existing.wallSum += r.wallClockMs;
      existing.wallCount += 1;
    }
    existing.commits += r.commits ?? 0;
    byPreset.set(r.preset, existing);
  }
  if (byPreset.size === 0) return null;
  const rows = [...byPreset.entries()]
    .map(([preset, agg]) => ({
      preset,
      total: agg.total,
      completed: agg.completed,
      successRate: agg.total > 0 ? agg.completed / agg.total : 0,
      meanWallMs: agg.wallCount > 0 ? agg.wallSum / agg.wallCount : 0,
      commits: agg.commits,
    }))
    .sort((a, b) => b.total - a.total);
  const totalRuns = rows.reduce((acc, r) => acc + r.total, 0);
  return (
    <div className="px-3 pt-3 pb-2 border-b border-ink-700 bg-ink-800/40">
      <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-2">
        Aggregate · {totalRuns} historical runs across {rows.length} preset{rows.length === 1 ? "" : "s"}
      </div>
      <div className="grid grid-cols-[100px_50px_120px_70px_50px] gap-x-3 gap-y-1 text-[11px] font-mono">
        <span className="text-ink-500 text-[9px] uppercase">Preset</span>
        <span className="text-ink-500 text-[9px] uppercase text-right">Runs</span>
        <span className="text-ink-500 text-[9px] uppercase">Success rate</span>
        <span className="text-ink-500 text-[9px] uppercase text-right">Mean wall</span>
        <span className="text-ink-500 text-[9px] uppercase text-right">Commits</span>
        {rows.map((row) => {
          const ratePct = Math.round(row.successRate * 100);
          const wallSec = Math.round(row.meanWallMs / 1000);
          const wallFmt = wallSec < 60 ? `${wallSec}s` : `${Math.floor(wallSec / 60)}m${(wallSec % 60).toString().padStart(2, "0")}s`;
          const barColor = ratePct >= 80 ? "bg-emerald-500" : ratePct >= 50 ? "bg-amber-500" : "bg-rose-500";
          return (
            <React.Fragment key={row.preset}>
              <span className="text-ink-200 truncate" title={row.preset}>
                {row.preset}
              </span>
              <span className="text-ink-300 text-right tabular-nums">{row.total}</span>
              <span className="flex items-center gap-1.5">
                <div className="flex-1 h-1.5 bg-ink-900 rounded overflow-hidden min-w-[40px]">
                  <div className={`h-full ${barColor}`} style={{ width: `${ratePct}%` }} />
                </div>
                <span className="text-ink-300 text-[10px] tabular-nums w-8 text-right">{ratePct}%</span>
              </span>
              <span className="text-ink-300 text-right tabular-nums">{wallFmt}</span>
              <span className="text-ink-300 text-right tabular-nums">{row.commits}</span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// Read-only modal showing a prior run's full summary (2026-04-24
// redesign): grid layout, fetches the full summary.json on open
// (was: only the thin digest), shows per-agent latency table,
// run-level counters, git status preview, contract criteria.
// Adds an "Open summary JSON" button that pops the raw JSON into
// a new tab so users can grep through what they need.
//
// Transcript replay is still deferred — the runner doesn't persist
// transcripts past run-end yet (queued as task #65). Until then,
// "review past run as if live" isn't possible.
function RunDigestModal({ digest, onClose }: { digest: RunSummaryDigest; onClose: () => void }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Task #111: track whether the loaded summary came from localStorage
  // (server unreachable) so the modal can show a "[cached]" badge.
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setFromCache(false);
      try {
        const params = new URLSearchParams({
          clonePath: digest.clonePath,
          ...(digest.runId ? { runId: digest.runId } : {}),
        });
        const r = await fetch(`/api/swarm/run-summary?${params.toString()}`);
        if (!r.ok) {
          if (r.status === 404) {
            // No full summary file yet (run in progress or very recent); fall back to digest info.
            if (!cancelled) setLoading(false);
            return;
          }
          // Task #111: HTTP-error fallback to cache (e.g. server up but
          // file missing — rarer case, but cache may still have it).
          if (!cancelled) {
            const cached = cachedRunSummary(digest.clonePath, digest.runId);
            if (cached) {
              setSummary(cached);
              setFromCache(true);
            } else {
              setError(`HTTP ${r.status}`);
            }
          }
          return;
        }
        const body = (await r.json()) as RunSummary;
        if (!cancelled) {
          setSummary(body);
          cacheRunSummary(digest.clonePath, digest.runId, body);
        }
      } catch (err) {
        // Task #111: network-error fallback to cache.
        if (!cancelled) {
          const cached = cachedRunSummary(digest.clonePath, digest.runId);
          if (cached) {
            setSummary(cached);
            setFromCache(true);
          } else {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [digest.clonePath, digest.runId]);

  const summaryUrl = `/api/swarm/run-summary?clonePath=${encodeURIComponent(digest.clonePath)}${
    digest.runId ? `&runId=${encodeURIComponent(digest.runId)}` : ""
  }`;

  // Fall back to digest fields when the full summary fetch hasn't
  // landed yet — digest is a strict subset, so the header always
  // renders something useful.
  const head = summary ?? {
    repoUrl: "",
    localPath: digest.clonePath,
    preset: digest.preset,
    model: digest.model,
    startedAt: digest.startedAt,
    endedAt: digest.endedAt,
    wallClockMs: digest.wallClockMs,
    stopReason: (digest.stopReason ?? "") as RunSummary["stopReason"],
    commits: digest.commits ?? 0,
    staleEvents: 0,
    skippedTodos: 0,
    totalTodos: digest.totalTodos ?? 0,
    filesChanged: 0,
    finalGitStatus: "",
    finalGitStatusTruncated: false,
    agents: [] as PerAgentStat[],
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border border-ink-600 rounded-lg shadow-2xl w-[min(1400px,95vw)] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-ink-900 border-b border-ink-700 px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-ink-100 truncate">{digest.name}</h3>
            <div className="text-[10px] font-mono text-ink-500 truncate flex items-center gap-2">
              <span>{digest.runId ? `run ${digest.runId}` : "(no runId)"}</span>
              {/* Task #111: cache badge when modal loaded from localStorage. */}
              {fromCache ? (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-300"
                  title="Server unreachable — showing cached summary from localStorage."
                >
                  cached
                </span>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-100 text-lg leading-none px-2"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Identity grid */}
          <section>
            <SectionLabel>Identity</SectionLabel>
            <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono">
              <DataLabel>Preset</DataLabel>
              <DataValue>{head.preset}</DataValue>
              <DataLabel>Model</DataLabel>
              <DataValue>{head.model}</DataValue>
              {head.repoUrl ? (
                <>
                  <DataLabel>Repo</DataLabel>
                  <DataValue>
                    <a
                      href={head.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-300 hover:text-sky-200 underline break-all"
                    >
                      {head.repoUrl}
                    </a>
                  </DataValue>
                </>
              ) : null}
              <DataLabel>Clone path</DataLabel>
              <DataValue><span className="break-all text-ink-300">{head.localPath}</span></DataValue>
              <DataLabel>Started</DataLabel>
              <DataValue>{new Date(head.startedAt).toLocaleString()}</DataValue>
              {head.endedAt > 0 ? (
                <>
                  <DataLabel>Ended</DataLabel>
                  <DataValue>{new Date(head.endedAt).toLocaleString()}</DataValue>
                </>
              ) : null}
              {head.wallClockMs > 0 ? (
                <>
                  <DataLabel>Wall-clock</DataLabel>
                  <DataValue>{formatRuntimeMs(head.wallClockMs)}</DataValue>
                </>
              ) : null}
              {head.stopReason ? (
                <>
                  <DataLabel>Stop reason</DataLabel>
                  <DataValue>{head.stopReason}</DataValue>
                </>
              ) : null}
            </div>
            {summary?.startCommand ? (
              <details className="mt-2 group">
                <summary className="text-[10px] text-ink-400 cursor-pointer hover:text-ink-200 select-none">
                  CLI command used to start this run
                </summary>
                <pre className="mt-1 p-2 rounded bg-ink-950 border border-ink-700 text-[10px] font-mono text-ink-300 overflow-x-auto whitespace-pre-wrap">
                  {summary.startCommand}
                </pre>
              </details>
            ) : null}
          </section>

          {/* Phase 4a of #243: full topology read-only grid. Shows the
              exact agent specs the run used (planner role, model overrides,
              etc.) so users can audit decisions after the fact. Falls
              back to "(no topology recorded)" for older summaries. */}
          {summary?.topology ? (
            <section>
              <SectionLabel>
                Topology — {summary.topology.agents.length}{" "}
                {summary.topology.agents.length === 1 ? "agent" : "agents"}
              </SectionLabel>
              <div className="rounded border border-ink-700 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-ink-800/60 text-[9px] uppercase tracking-wider text-ink-500">
                    <tr>
                      <th className="px-2 py-1 text-left w-10">#</th>
                      <th className="px-2 py-1 text-left">Role</th>
                      <th className="px-2 py-1 text-left">Model</th>
                      <th className="px-2 py-1 text-left">Removable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topology.agents.map((a) => (
                      <tr key={a.index} className="border-t border-ink-800/60">
                        <td className="px-2 py-1 text-ink-400 font-mono">{a.index}</td>
                        <td className="px-2 py-1 text-ink-200">
                          {a.removable ? a.role : `🔒 ${a.role}`}
                        </td>
                        <td className="px-2 py-1 text-ink-300 font-mono">
                          {a.model ?? <span className="text-ink-600">(default)</span>}
                        </td>
                        <td className="px-2 py-1 text-ink-500">
                          {a.removable ? "yes" : "structural"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* Run-level counters */}
          {summary ? (
            <section>
              <SectionLabel>Counters</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Commits" value={summary.commits} />
                <Stat label="Files changed" value={summary.filesChanged} />
                <Stat label="Total todos" value={summary.totalTodos} />
                <Stat label="Skipped todos" value={summary.skippedTodos} />
                <Stat label="Stale events" value={summary.staleEvents} />
                <Stat label="Agents" value={summary.agents.length} />
              </div>
            </section>
          ) : null}

          {/* Deliverables — created/modified file chips */}
          {summary && summary.deliverables && summary.deliverables.length > 0 ? (
            <section>
              <SectionLabel>Deliverables ({summary.deliverables.length})</SectionLabel>
              <div className="flex flex-wrap gap-1">
                {summary.deliverables.map((d) => (
                  <span
                    key={d.path}
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                      d.status === "created"
                        ? "bg-emerald-900/40 border-emerald-700/50 text-emerald-300"
                        : "bg-ink-700 border-ink-600 text-ink-300"
                    }`}
                  >
                    {d.path}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {/* Per-agent table */}
          {summary && summary.agents.length > 0 ? (
            <section>
              <AgentStatsTable
                label={`Per-agent (${summary.agents.length})`}
                rows={rowsFromPerAgentStats(summary.agents, summary.preset)}
              />
            </section>
          ) : null}

          {/* Contract criteria (blackboard only) */}
          {summary?.contract ? (
            <section>
              <SectionLabel>Contract — {summary.contract.criteria.length} criteria</SectionLabel>
              {summary.contract.missionStatement ? (
                <div className="text-ink-300 italic mb-1">{summary.contract.missionStatement}</div>
              ) : null}
              <ul className="space-y-1">
                {summary.contract.criteria.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <span className={
                      c.status === "met" ? "text-emerald-400"
                      : c.status === "wont-do" ? "text-amber-400"
                      : "text-ink-500"
                    }>
                      {c.status === "met" ? "✓" : c.status === "wont-do" ? "✕" : "○"}
                    </span>
                    <span className="text-ink-300">{c.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* V2 reducer + queue state. Blackboard-only. After cutover
              Phase 1a (2026-04-28), the divergence-tracking chips +
              tables are gone — V2 events ran clean across 7/7 SDK
              presets and 4 V2 worker commits, so the parallel-track
              comparison was retired. The remaining display is a
              single-line snapshot of where V2 ended up. */}
          {summary?.v2State || summary?.v2QueueState ? (
            <section>
              <SectionLabel>V2 final state</SectionLabel>
              <div className="flex flex-wrap items-baseline gap-2 text-[11px]">
                {summary.v2State ? (
                  <span className="px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider bg-emerald-900/60 text-emerald-200">
                    phase: {summary.v2State.phase}
                  </span>
                ) : null}
                {summary.v2QueueState ? (
                  <span className="px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider bg-emerald-900/60 text-emerald-200">
                    queue: {summary.v2QueueState.counts.completed}/{summary.v2QueueState.counts.total}
                  </span>
                ) : null}
                {summary.v2State?.pausedReason ? (
                  <span className="text-amber-300 text-[10px]">paused: {summary.v2State.pausedReason}</span>
                ) : null}
                {summary.v2State?.detail ? (
                  <span className="text-ink-400 text-[10px]">{summary.v2State.detail}</span>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Final git status */}
          {summary?.finalGitStatus ? (
            <section>
              <SectionLabel>
                Final git status
                {summary.finalGitStatusTruncated ? <span className="text-amber-400"> (truncated)</span> : null}
              </SectionLabel>
              <pre className="text-[10px] font-mono text-ink-400 bg-ink-950/60 border border-ink-700 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
                {summary.finalGitStatus.trim() || "(clean)"}
              </pre>
            </section>
          ) : null}

          {/* Loading / error state */}
          {loading ? (
            <div className="text-ink-500 italic">Loading full summary…</div>
          ) : null}
          {error && !summary ? (
            <div className="text-rose-300">Failed to load full summary: {error}</div>
          ) : null}
          {!loading && !error && !summary ? (
            <div className="text-ink-500 italic">
              No matching summary on disk. Showing digest only.
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-ink-900 border-t border-ink-700 px-5 py-3 flex flex-wrap justify-end gap-2">
          {/* Task #65: open the run in a fresh tab as if it were live —
              new tab parses ?review + ?path, hydrates store from the
              saved summary, and reuses SwarmView's existing panels
              (transcript / metrics / agent cards). Disabled when the
              summary has no transcript (legacy runs predate task #65). */}
          {digest.runId ? (
            <a
              href={`/?review=${encodeURIComponent(digest.runId)}&path=${encodeURIComponent(digest.clonePath)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={summary?.transcript
                ? `Replay this run in a new tab (${summary.transcript.length} transcript entries)`
                : "Open the run in a new tab — transcript replay only works on runs after task #65 landed"}
              className="text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100 border border-emerald-600 font-medium"
            >
              Open run review ↗
            </a>
          ) : null}
          <a
            href={summaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Open summary JSON ↗
          </a>
          <button
            onClick={() => {
              void fetch("/api/swarm/open", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: digest.clonePath }),
              }).catch(() => {});
            }}
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Open folder
          </button>
          <button
            onClick={() => {
              const cp = digest.clonePath;
              const ru = summary?.repoUrl || "";
              const ps = digest.preset;
              const md = digest.model || "";
              const parent = ru
                ? cp.replace(/[/\\][^/\\]*$/, "")
                : cp;
              const params = new URLSearchParams();
              params.set("parentPath", parent);
              if (ru) params.set("repoUrl", ru);
              params.set("preset", ps);
              if (md) params.set("model", md);
              params.set("autoStart", "1");
              // Direct start (with prefill) reusing the clone. The autoStart param triggers
              // immediate performStart after form hydrate. Server reuses existing clone dir.
              window.location.href = `/?${params.toString()}`;
              onClose();
            }}
            className="text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100 border border-emerald-600"
            title="Start a new swarm run reusing this clone's directory and current files"
          >
            Start new swarm on this clone
          </button>
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
      {children}
    </div>
  );
}

function DataLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-500">{children}</div>;
}

function DataValue({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-200 min-w-0">{children}</div>;
}

// 2026-04-25 fine-tune (Kevin): per-agent table cells render zero/null
// values as "—" at opacity-50 (matches dropdown + headline-tile
// convention). Reuses the caller's className for padding/alignment,
// adds opacity-50 when empty.
function NumOrDashCell({ value, className }: { value: number | null | undefined; className: string }) {
  const isEmpty = !value;
  if (isEmpty) {
    return <td className={`${className} opacity-50`}>—</td>;
  }
  return <td className={className}>{value.toLocaleString()}</td>;
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  // 2026-04-25: Kevin updated preference — modal Stat tiles show "—"
  // for blank/zero so the empty state is unambiguous (was blank in
  // earlier #86 fine-tune). 2026-04-25 v2: opacity-50 on the dash
  // matches the dropdown table convention.
  const display = !value ? "—" : value.toLocaleString();
  const isEmpty = !value;
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`font-mono text-sm min-h-[1.25rem] ${isEmpty ? "text-ink-400 opacity-50" : "text-ink-100"}`}>
        {display}
      </div>
    </div>
  );
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Mirror of agentRole() inside SwarmView — modal only knows preset
// + index, not the live runConfig. Kept in sync so dropdown rows
// show the same role names users see in AgentPanel during a run.
export function roleForRow(preset: string, idx: number, totalAgents: number): string {
  switch (preset) {
    case "blackboard":
      if (idx === 1) return "planner";
      if (idx > totalAgents - 1) return "auditor";
      return "worker";
    case "orchestrator-worker":
      return idx === 1 ? "orchestrator" : "worker";
    case "orchestrator-worker-deep": {
      if (idx === 1) return "orchestrator";
      const remaining = Math.max(0, totalAgents - 1);
      const targetK = Math.max(1, Math.ceil(remaining / 6));
      const maxK = Math.max(1, Math.floor(remaining / 3));
      const k = Math.min(targetK, maxK);
      return idx <= 1 + k ? "mid-lead" : "worker";
    }
    case "map-reduce":
      return idx === 1 ? "reducer" : "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      if (idx === 1) return "pro";
      if (idx === 2) return "con";
      if (idx === 3) return "judge";
      return "peer";
    default:
      return idx === 1 ? "planner" : "worker";
  }
}

// 2026-04-25 fine-tune: two duration formatters per Kevin.
//
// formatDurationCompact — colon-digital for the history dropdown
//   table where the column is narrow and rows benefit from
//   tight scannable runtimes:
//     1m 4s        → "1:4"
//     12h 12m 13s  → "12:12:13"
//     4d 15h 12m 12s → "4:15:12:12"
//     30s alone    → "0:30" (always show m:s — matches stopwatch)
//
// formatRuntimeMs — spaced "3 m 24 s" for the modal's Identity
//   grid where there's room and English units read better at
//   review time.
function formatDurationCompact(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // 2026-04-25 fine-tune (Kevin):
  // - 2-digit pad each non-leading segment so colons align vertically.
  // - When the leading minute is 0, drop the "0:" prefix and just show
  //   the seconds bare (e.g. "12" instead of "0:12").
  // - When everything is 0, return "—" (caller's column is "no-data"
  //   styled so the dash signals "no time recorded").
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}:${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  if (m > 0) return `${m}:${pad(s)}`;
  if (s > 0) return `${s}`;
  return "—";
}
function formatRuntimeMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} d ${h} h ${m} m ${s} s`;
  if (h > 0) return `${h} h ${m} m ${s} s`;
  if (m > 0) return `${m} m ${s} s`;
  return `${s} s`;
}

// Phase 4a of #243: compact topology chip for the dropdown row. Shows
// role-letter · count groups (e.g. 1P · 4W · 1A) so users can scan
// "what shape was this run" at a glance. Hover reveals the full role
// list. Older summaries without topology render "—" at half opacity.
const ROLE_LETTER: Record<AgentRole, string> = {
  planner: "P",
  worker: "W",
  auditor: "A",
  orchestrator: "O",
  "mid-lead": "M",
  reducer: "R",
  mapper: "M",
  drafter: "D",
  explorer: "E",
  peer: "·",
  pro: "+",
  con: "−",
  judge: "J",
  "role-diff": "R",
};
function TopologyChip({ topology }: { topology: Topology | undefined }) {
  if (!topology || topology.agents.length === 0) {
    return <span className="text-ink-400 opacity-50">—</span>;
  }
  // Group consecutive same-role rows for the compact summary. Use a
  // Map keyed by role to preserve first-seen order while collapsing
  // identical roles together.
  const counts = new Map<AgentRole, number>();
  for (const a of topology.agents) {
    counts.set(a.role, (counts.get(a.role) ?? 0) + 1);
  }
  const compact = Array.from(counts.entries())
    .map(([role, n]) => `${n}${ROLE_LETTER[role] ?? "?"}`)
    .join(" · ");
  // Title surfaces the full role list so users hovering can see
  // exact specs without opening the modal.
  const tooltip = topology.agents
    .map((a) => `#${a.index} ${a.role}${a.model ? ` (${a.model})` : ""}`)
    .join("\n");
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded border bg-ink-800/60 border-ink-700/60 text-ink-300 font-mono"
      title={tooltip}
    >
      {compact}
    </span>
  );
}

// Task #86 (2026-04-25): color-coded chip per swarm preset. Same
// hue per preset across the dropdown + (future) anywhere else
// preset names appear, so users build muscle memory for "council
// = sky, blackboard = emerald, debate-judge = amber" etc.
const PRESET_CHIP_STYLES: Record<string, string> = {
  blackboard: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  council: "bg-sky-900/40 border-sky-700/50 text-sky-200",
  "orchestrator-worker": "bg-amber-900/40 border-amber-700/50 text-amber-200",
  // Task #131: deep variant gets a slightly deeper amber so the chip
  // distinguishes from flat OW at a glance.
  "orchestrator-worker-deep": "bg-amber-950/60 border-amber-600/60 text-amber-100",
  "map-reduce": "bg-violet-900/40 border-violet-700/50 text-violet-200",
  "role-diff": "bg-fuchsia-900/40 border-fuchsia-700/50 text-fuchsia-200",
  "debate-judge": "bg-rose-900/40 border-rose-700/50 text-rose-200",
  stigmergy: "bg-teal-900/40 border-teal-700/50 text-teal-200",
  "round-robin": "bg-ink-700 border-ink-600 text-ink-200",
};
function PresetChip({ preset }: { preset: string }) {
  const cls = PRESET_CHIP_STYLES[preset] ?? "bg-ink-700 border-ink-600 text-ink-200";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${cls}`}>
      {preset}
    </span>
  );
}

// Task #86: stopReason chip with semantic coloring. Distinguishes
// natural completion from user-stop from cap-trip from crash.
function ResultChip({ reason }: { reason: string }) {
  let cls = "bg-ink-700 border-ink-600 text-ink-300";
  let label = reason;
  if (reason === "completed") {
    cls = "bg-emerald-900/40 border-emerald-700/50 text-emerald-300";
    label = "completed";
  } else if (reason === "user") {
    cls = "bg-ink-800 border-ink-700 text-ink-400";
    label = "stopped";
  } else if (reason === "crash" || reason === "failed") {
    cls = "bg-rose-900/40 border-rose-700/50 text-rose-300";
    label = "crashed";
  } else if (reason.startsWith("cap:")) {
    cls = "bg-amber-900/40 border-amber-700/50 text-amber-300";
    label = reason.replace("cap:", "cap·");
  } else if (reason === "early-stop") {
    cls = "bg-sky-900/40 border-sky-700/50 text-sky-300";
    label = "early-stop";
  } else if (reason === "no-progress") {
    cls = "bg-amber-900/40 border-amber-700/50 text-amber-300";
    label = "no-progress";
  } else if (reason === "partial-progress") {
    cls = "bg-sky-900/40 border-sky-700/50 text-sky-300";
    label = "partial-progress";
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${cls}`}>
      {label}
    </span>
  );
}

// 2026-04-25 fine-tune: always show date alongside time per Kevin's
// review. Today's runs cluster at the top of the dropdown so the date
// is helpful to anchor "this run was yesterday" vs "this morning."
//
// 2026-04-25 align-tweak (Kevin): hide the leading-zero "0" digits
// while keeping vertical alignment of "/", ":", and AM/PM across
// rows. Use figure-space (U+2007) — a Unicode "digit-blank" that's
// defined to occupy the same width as a digit in tabular-nums /
// monospace fonts. Result: "04/25 07:08" displays as " 4/25  7: 8"
// where each leading zero is replaced by an invisible digit-width
// slot, so a single-digit row still right-pads to the same column
// positions as a two-digit row. Hand-built (vs locale string) so we
// can control every component independently.
function fmtTimeShort(ts: number): string {
  const d = new Date(ts);
  const FS = " "; // figure-space — digit-width blank
  const padInvis = (n: number): string => (n < 10 ? `${FS}${n}` : `${n}`);
  const date = `${padInvis(d.getMonth() + 1)}/${padInvis(d.getDate())}`;
  // 12-hour clock with AM/PM, single-digit hours and minutes show as
  // figure-space + digit so the colon stays in the same column.
  let hour = d.getHours();
  const isAM = hour < 12;
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const time = `${padInvis(hour)}:${padInvis(d.getMinutes())} ${isAM ? "AM" : "PM"}`;
  return `${date} · ${time}`;
}
