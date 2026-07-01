import { useEffect, useRef, useState } from "react";
import type { RunSummary, RunSummaryDigest } from "../types";
import { fmtMs } from "./RunHistory";

interface TimelineEntry extends RunSummaryDigest {
  summary?: RunSummary;
  loading?: boolean;
  error?: string;
}

function countCharsAndWords(entries: { text: string }[]): { chars: number; words: number } {
  let chars = 0;
  let words = 0;
  for (const e of entries) {
    chars += e.text.length;
    words += e.text.split(/\s+/).filter(Boolean).length;
  }
  return { chars, words };
}

function presetColor(preset: string): string {
  switch (preset) {
    case "blackboard": return "bg-emerald-600";
    case "council": return "bg-violet-600";
    case "debate-judge": return "bg-amber-600";
    case "role-diff": return "bg-cyan-600";
    case "map-reduce": return "bg-fuchsia-600";
    case "stigmergy": return "bg-orange-600";
    case "round-robin": return "bg-sky-600";
    case "orchestrator-worker": case "orchestrator-worker-deep": return "bg-rose-600";
    default: return "bg-slate-600";
  }
}

function stopReasonColor(reason: string | undefined): string {
  switch (reason) {
    case "completed": return "text-emerald-400";
    case "no-progress": return "text-amber-400";
    case "partial-progress": return "text-amber-300";
    case "user": return "text-rose-400";
    case "crash": return "text-red-500";
    default:
      return reason?.startsWith("cap:") ? "text-amber-400" : "text-ink-400";
  }
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function fmtWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TranscriptTimeline({ parentPath }: { parentPath?: string } = {}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetchCtrlRef.current = ctrl;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (parentPath) params.set("parentPath", parentPath);
        const res = await fetch(`/api/swarm/runs?${params}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const list: TimelineEntry[] = (data.runs || []).sort(
          (a: RunSummaryDigest, b: RunSummaryDigest) => b.startedAt - a.startedAt,
        );
        setEntries(list);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);

  async function loadSummary(clonePath: string, runId: string | undefined) {
    const key = runId ?? clonePath;
    setEntries((prev) =>
      prev.map((e) => {
        const ek = e.runId ?? e.clonePath;
        if (ek !== key) return e;
        return { ...e, loading: true, error: undefined };
      }),
    );
    try {
      const ctrl = new AbortController();
      const params = new URLSearchParams({ clonePath });
      if (runId) params.set("runId", runId);
      const res = await fetch(`/api/swarm/run-summary?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const summary: RunSummary = await res.json();
      setEntries((prev) =>
        prev.map((e) => {
          const ek = e.runId ?? e.clonePath;
          if (ek !== key) return e;
          return { ...e, summary, loading: false };
        }),
      );
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) => {
          const ek = e.runId ?? e.clonePath;
          if (ek !== key) return e;
          return { ...e, loading: false, error: err instanceof Error ? err.message : String(err) };
        }),
      );
    }
  }

  function toggle(runId: string | undefined, clonePath: string) {
    const key = runId ?? clonePath;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    // Load summary if not already loaded
    const entry = entries.find((e) => (e.runId ?? e.clonePath) === key);
    if (entry && !entry.summary && !entry.loading) {
      loadSummary(clonePath, runId);
    }
  }

  if (loading) {
    return (
      <div className="h-full overflow-y-auto p-6 flex items-center justify-center">
        <div className="text-ink-400">Loading run history...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto p-6 flex items-center justify-center">
        <div className="text-rose-400 bg-rose-900/20 border border-rose-700 rounded px-4 py-2">
          Failed to load history: {error}
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-6 flex items-center justify-center">
        <div className="text-ink-400">No runs yet. Start a swarm to see history here.</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Aggregate header */}
      <div className="sticky top-0 z-10 bg-ink-800/95 backdrop-blur border-b border-ink-700 px-6 py-3">
        <div className="text-sm font-semibold text-ink-200 flex items-baseline gap-3">
          <span>Run history</span>
          <span className="text-xs text-ink-500 font-normal">
            {entries.length} run{entries.length !== 1 ? "s" : ""}
          </span>
          <span className="text-xs text-ink-600 font-mono">
            {entries.filter((e) => e.stopReason === "completed").length} completed
          </span>
        </div>
      </div>

      <div className="px-6 py-4 space-y-3">
        {entries.map((entry, i) => {
          const key = entry.runId ?? entry.clonePath;
          const isOpen = expanded.has(key);
          const hasContract = entry.hasContract;
          const summary = entry.summary;

          return (
            <div
              key={key}
              className="border border-ink-700 rounded bg-ink-800/50 hover:bg-ink-800 transition-colors"
            >
              {/* Row header — always visible */}
              <button
                type="button"
                onClick={() => toggle(entry.runId, entry.clonePath)}
                className="w-full text-left px-4 py-3 flex items-center gap-3"
              >
                {/* Timeline dot */}
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${presetColor(entry.preset)}`} />

                {/* Time + preset + model */}
                <div className="flex-1 min-w-0 grid grid-cols-4 gap-3 items-center text-xs">
                  <div className="text-ink-300 font-mono">
                    {fmtDate(entry.startedAt)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold text-white ${presetColor(entry.preset)}`}>
                      {entry.preset}
                    </span>
                    <span className="text-ink-500 truncate font-mono">{entry.model}</span>
                  </div>
                  <div className={`font-mono ${stopReasonColor(entry.stopReason)}`}>
                    {entry.stopReason ?? "—"}
                  </div>
                  <div className="flex items-center gap-3 text-ink-400">
                    <span title="Commits" className="tabular-nums">
                      {entry.commits != null ? `${entry.commits}c` : "—"}
                    </span>
                    <span title="Todos" className="tabular-nums">
                      {entry.totalTodos != null ? `${entry.totalTodos}t` : "—"}
                    </span>
                    <span title="Wall clock" className="tabular-nums text-ink-500">
                      {fmtMs(entry.wallClockMs)}
                    </span>
                    {hasContract ? (
                      <span className="text-violet-400" title="Has contract">&#9674;</span>
                    ) : null}
                  </div>
                </div>

                {/* Expand chevron */}
                <span className={`text-ink-500 text-sm transition-transform ${isOpen ? "rotate-90" : ""}`}>
                  &#9654;
                </span>
              </button>

              {/* Expanded detail */}
              {isOpen ? (
                <div className="border-t border-ink-700 px-4 py-3 space-y-3 text-xs">
                  {entry.loading ? (
                    <div className="text-ink-500 italic py-2">Loading details...</div>
                  ) : entry.error ? (
                    <div className="text-rose-400 py-2">{entry.error}</div>
                  ) : summary ? (
                    <>
                      {/* Mission + criteria */}
                      {summary.contract ? (
                        <div>
                          <div className="text-ink-500 uppercase tracking-wider text-[10px] mb-1">
                            Mission
                          </div>
                          <div className="text-ink-200 font-medium mb-2">
                            {summary.contract.missionStatement}
                          </div>
                          <div className="text-ink-500 uppercase tracking-wider text-[10px] mb-1">
                            Criteria ({summary.contract.criteria.length})
                          </div>
                          <ul className="space-y-1">
                            {summary.contract.criteria.map((c, ci) => (
                              <li key={ci} className="text-ink-400 flex gap-2">
                                <span className="text-ink-600 shrink-0">{ci + 1}.</span>
                                <span>{c.description}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <div className="text-ink-500 italic">No contract — discussion preset</div>
                      )}

                      {/* Transcript stats */}
                      {summary.transcript && summary.transcript.length > 0 ? (
                        (() => {
                          const cw = countCharsAndWords(summary.transcript);
                          return (
                            <div className="grid grid-cols-4 gap-2">
                              <div className="bg-ink-900/50 rounded p-2 text-center">
                                <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Messages</div>
                                <div className="text-ink-200 font-mono font-semibold">
                                  {summary.transcript.length}
                                  {summary.transcriptTruncated ? "+" : ""}
                                </div>
                              </div>
                              <div className="bg-ink-900/50 rounded p-2 text-center">
                                <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Characters</div>
                                <div className="text-ink-200 font-mono font-semibold">{fmtChars(cw.chars)}</div>
                              </div>
                              <div className="bg-ink-900/50 rounded p-2 text-center">
                                <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Words</div>
                                <div className="text-ink-200 font-mono font-semibold">{fmtWords(cw.words)}</div>
                              </div>
                              <div className="bg-ink-900/50 rounded p-2 text-center">
                                <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Files</div>
                                <div className="text-ink-200 font-mono font-semibold">{summary.filesChanged ?? "—"}</div>
                              </div>
                            </div>
                          );
                        })()
                      ) : (
                        <div className="text-ink-500 italic">No transcript snapshot available</div>
                      )}

                      {/* Additional stats */}
                      <div className="grid grid-cols-4 gap-2">
                        <div className="bg-ink-900/50 rounded p-2 text-center">
                          <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Skipped</div>
                          <div className="text-ink-200 font-mono font-semibold">{summary.skippedTodos ?? 0}</div>
                        </div>
                        <div className="bg-ink-900/50 rounded p-2 text-center">
                          <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Stale</div>
                          <div className="text-ink-200 font-mono font-semibold">{summary.staleEvents ?? 0}</div>
                        </div>
                        <div className="bg-ink-900/50 rounded p-2 text-center">
                          <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Commits</div>
                          <div className="text-ink-200 font-mono font-semibold">{summary.commits}</div>
                        </div>
                        <div className="bg-ink-900/50 rounded p-2 text-center">
                          <div className="text-ink-500 text-[10px] uppercase tracking-wider mb-0.5">Agents</div>
                          <div className="text-ink-200 font-mono font-semibold">{summary.agents.length}</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-ink-500 italic">Click to load details</div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
