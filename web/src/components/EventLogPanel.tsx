// V2 Step 6b: minimal UI surface for the event-log endpoint.
// Header button → click → fetches /api/v2/event-log/runs and renders
// a dropdown list of per-run summaries derived from the JSONL stream.
//
// This is a viewer, not a replacement for the WS-state UI yet. Step 6c
// would replace the WS-snapshot mirror with this stream-derived state.

import { useEffect, useRef, useState } from "react";

interface DerivedRunState {
  runId?: string;
  preset?: string;
  startedAt?: number;
  finishedAt?: number;
  finalPhase?: string;
  errors: string[];
  transcriptCount: number;
  agentStateUpdates: number;
  hasSummary: boolean;
}

interface EventLogResponse {
  runs: Array<{
    derived: DerivedRunState;
    recordCount: number;
    isSessionBoundary: boolean;
  }>;
  malformed: number;
  source: string;
  totalRecords: number;
}

export function EventLogPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EventLogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump to force a refetch — useful when a run is in progress and
  // the user wants the latest derived state without closing the dropdown.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch("/api/v2/event-log/runs")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as EventLogResponse;
      })
      .then((j) => setData(j))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, refreshNonce]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] uppercase tracking-wide px-2 py-1 rounded bg-ink-800 hover:bg-ink-700 text-ink-300 border border-ink-600"
        title="V2 Step 6b: per-run summaries derived from logs/current.jsonl via EventLogReaderV2"
      >
        V2 event log
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-1 z-20 w-[480px] max-h-[60vh] overflow-y-auto rounded border border-ink-600 bg-ink-900 shadow-xl shadow-black/50 p-3">
          <div className="flex items-baseline gap-2 mb-2">
            <div className="text-[11px] text-ink-500 font-mono break-all flex-1">
              {data?.source ?? "loading…"}
            </div>
            <button
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={loading}
              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-200 disabled:opacity-50"
              title="Re-fetch /api/v2/event-log/runs"
            >
              {loading ? "…" : "refresh"}
            </button>
          </div>
          {loading ? (
            <div className="text-ink-400 text-sm italic">Loading…</div>
          ) : error ? (
            <div className="text-rose-300 text-sm">Error: {error}</div>
          ) : data && data.runs.length === 0 ? (
            <div className="text-ink-400 text-sm italic">No runs in log yet.</div>
          ) : data ? (
            <>
              <div className="text-[10px] text-ink-500 mb-2">
                {data.runs.length} slice{data.runs.length === 1 ? "" : "s"} · {data.totalRecords} records
                {data.malformed > 0 ? <span className="text-amber-400"> · {data.malformed} malformed</span> : null}
              </div>
              <ul className="space-y-1.5">
                {data.runs.map((r, i) => (
                  <RunRow key={i} run={r} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunRow({
  run,
}: {
  run: EventLogResponse["runs"][number];
}) {
  const d = run.derived;
  const startedStr = d.startedAt ? new Date(d.startedAt).toLocaleTimeString() : "—";
  const phase = d.finalPhase ?? "?";
  const phaseColor =
    phase === "completed" ? "text-emerald-300"
    : phase === "failed" ? "text-rose-300"
    : phase === "stopped" ? "text-amber-300"
    : "text-ink-300";
  return (
    <li className="rounded border border-ink-700 bg-ink-800/60 p-2 text-[11px]">
      <div className="flex items-baseline gap-2 mb-1">
        {run.isSessionBoundary ? (
          <span className="text-[9px] uppercase tracking-wider px-1 py-0 rounded bg-ink-700 text-ink-400">session</span>
        ) : (
          <span className="text-[9px] uppercase tracking-wider px-1 py-0 rounded bg-emerald-900/50 text-emerald-300">run</span>
        )}
        <span className={`font-mono ${phaseColor}`}>{phase}</span>
        <span className="text-ink-400 flex-1">{d.runId?.slice(0, 8) ?? ""}</span>
        <span className="text-ink-500">{startedStr}</span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px] text-ink-400">
        <div><span className="text-ink-500">preset:</span> {d.preset ?? "—"}</div>
        <div><span className="text-ink-500">transcript:</span> {d.transcriptCount}</div>
        <div><span className="text-ink-500">agent updates:</span> {d.agentStateUpdates}</div>
      </div>
      {d.errors.length > 0 ? (
        <div className="mt-1 text-rose-300 text-[10px]">
          {d.errors.length} error{d.errors.length === 1 ? "" : "s"}: {d.errors[0].slice(0, 80)}
          {d.errors[0].length > 80 ? "…" : ""}
        </div>
      ) : null}
      {d.hasSummary ? (
        <div className="mt-0.5 text-emerald-400 text-[10px]">✓ has run_summary</div>
      ) : null}
    </li>
  );
}
