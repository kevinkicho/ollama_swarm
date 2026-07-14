// T-Item-MultiTenant Phase 7 (2026-05-04): live list of all currently-
// active runs (server-wide, not parent-dir-scoped). Polls
// /api/swarm/active-runs every 5s. Surfaces runs the user may not be
// directly watching (e.g. a forward-chain that fired in a different
// tab) so they can navigate to them, soft-drain, or stop them.
//
// Per-run actions use /api/swarm/runs/:id/{stop,drain} so concurrent
// runs stay isolated. Stop shares SWARM_DRAIN_ON_STOP with SwarmView.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/apiFetch";

interface ActiveRun {
  runId: string;
  runConfig: {
    preset: string;
    plannerModel?: string;
    workerModel?: string;
    repoUrl?: string;
    clonePath?: string;
    agentCount?: number;
  };
  startedAt: number;
  isRunning: boolean;
  phase?: string;
  earlyStopDetail?: string;
  drainEligible?: boolean;
  currentAgentIndex?: number;
  brainInitiated?: boolean;
  brainProposalId?: string;
}

interface ActiveRunsResponse {
  runs: ActiveRun[];
}

const POLL_INTERVAL_MS = 5_000;

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function shortRunId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

async function fetchActiveRuns(signal?: AbortSignal): Promise<ActiveRun[]> {
  try {
    const res = await apiFetch("/api/swarm/active-runs", { signal });
    if (!res.ok) return [];
    const json = (await res.json()) as ActiveRunsResponse;
    return Array.isArray(json.runs) ? json.runs : [];
  } catch {
    return [];
  }
}

async function stopRun(runId: string): Promise<{ ok: boolean; action?: string }> {
  try {
    const res = await apiFetch(`/api/swarm/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const body = (await res.json().catch(() => ({}))) as { action?: string };
    return { ok: res.ok, action: body.action };
  } catch {
    return { ok: false };
  }
}

async function drainRun(runId: string): Promise<{ ok: boolean; mode?: string }> {
  try {
    const res = await apiFetch(`/api/swarm/runs/${encodeURIComponent(runId)}/drain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const body = (await res.json().catch(() => ({}))) as { mode?: string };
    return { ok: res.ok, mode: body.mode };
  } catch {
    return { ok: false };
  }
}

type BusyKind = "stop" | "drain";

const ActiveRunRow = memo(function ActiveRunRow({
  run,
  now,
  busy,
  onNavigate,
  onStop,
  onDrain,
}: {
  run: ActiveRun;
  now: number;
  busy: { runId: string; kind: BusyKind } | null;
  onNavigate: (runId: string) => void;
  onStop: (runId: string) => void;
  onDrain: (runId: string) => void;
}) {
  const elapsed = now - run.startedAt;
  const isBusy = busy?.runId === run.runId;
  const phase = run.phase ?? (run.isRunning ? "running" : "terminated");
  const progress =
    run.earlyStopDetail
      ? run.earlyStopDetail.length > 40
        ? `${run.earlyStopDetail.slice(0, 38)}…`
        : run.earlyStopDetail
      : run.currentAgentIndex != null
        ? `agent ${run.currentAgentIndex}/${run.runConfig.agentCount ?? "?"}`
        : "—";

  return (
    <tr className="border-t border-ink-700/60">
      <td className="py-1.5 pr-2 font-mono text-[11px] text-ink-200" title={run.runId}>
        {shortRunId(run.runId)}
        {run.brainInitiated ? (
          <span className="ml-1 text-[9px] px-1 rounded bg-violet-900/70 text-violet-200">
            Brain
          </span>
        ) : null}
      </td>
      <td className="py-1.5 px-2 text-[11px] text-ink-300">{run.runConfig.preset}</td>
      <td className="py-1.5 px-2 text-[11px] text-ink-400 tabular-nums">
        {run.runConfig.agentCount ?? "?"}
      </td>
      <td className="py-1.5 px-2 text-[11px] text-ink-400 max-w-[10rem] truncate" title={progress}>
        {progress}
      </td>
      <td className="py-1.5 px-2 text-[11px] text-ink-400 tabular-nums">{formatElapsed(elapsed)}</td>
      <td className="py-1.5 px-2 text-[11px] font-mono text-sky-300/90" title={run.phase}>
        {phase}
      </td>
      <td className="py-1.5 pl-2">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => onNavigate(run.runId)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 bg-ink-800 text-ink-300 hover:text-ink-100 hover:border-ink-500"
          >
            view
          </button>
          {run.isRunning ? (
            <>
              <button
                type="button"
                disabled={isBusy || run.drainEligible === false}
                onClick={() => onDrain(run.runId)}
                title={
                  run.drainEligible === false
                    ? "Soft drain not eligible for this phase"
                    : "Soft drain: finish in-flight work, then stop"
                }
                className="text-[10px] px-1.5 py-0.5 rounded border border-amber-800/70 bg-amber-950/40 text-amber-200 hover:bg-amber-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy?.runId === run.runId && busy.kind === "drain" ? "draining…" : "drain"}
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onStop(run.runId)}
                title="Hard stop (or soft-drain first if SWARM_DRAIN_ON_STOP)"
                className="text-[10px] px-1.5 py-0.5 rounded border border-rose-800/70 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy?.runId === run.runId && busy.kind === "stop" ? "stopping…" : "stop"}
              </button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
});

export const ActiveRunsPanel = memo(function ActiveRunsPanel() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<{ runId: string; kind: BusyKind } | null>(null);
  const pollRef = useRef<AbortController | null>(null);

  const onNavigate = useCallback((runId: string) => {
    navigate(`/runs/${encodeURIComponent(runId)}`);
  }, [navigate]);

  const refresh = useCallback(async () => {
    const next = await fetchActiveRuns(pollRef.current?.signal);
    setRuns(next);
  }, []);

  const handleStop = useCallback(async (runId: string) => {
    setBusy({ runId, kind: "stop" });
    try {
      await stopRun(runId);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleDrain = useCallback(async (runId: string) => {
    setBusy({ runId, kind: "drain" });
    try {
      await drainRun(runId);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  useEffect(() => {
    const ctrl = new AbortController();
    pollRef.current = ctrl;
    let cancelled = false;
    const tick = async () => {
      const next = await fetchActiveRuns(ctrl.signal);
      if (!cancelled) setRuns(next);
    };
    void tick();
    const interval = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      ctrl.abort();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (runs.length < 1) return null;

  return (
    <div className="mx-3 my-2 rounded border border-ink-600 bg-ink-900/80 px-3 py-2 text-xs text-ink-200 shadow-sm">
      <div className="font-semibold text-ink-100 mb-1.5 flex items-center gap-2">
        <span>Active runs ({runs.length})</span>
        <span className="text-[10px] font-normal text-ink-500">
          multi-tenant · per-run drain/stop
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-ink-500">
              <th className="py-1 pr-2 font-medium">Run</th>
              <th className="py-1 px-2 font-medium">Preset</th>
              <th className="py-1 px-2 font-medium">Agents</th>
              <th className="py-1 px-2 font-medium">Progress</th>
              <th className="py-1 px-2 font-medium">Elapsed</th>
              <th className="py-1 px-2 font-medium">Phase</th>
              <th className="py-1 pl-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <ActiveRunRow
                key={run.runId}
                run={run}
                now={now}
                busy={busy}
                onNavigate={onNavigate}
                onStop={handleStop}
                onDrain={handleDrain}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
