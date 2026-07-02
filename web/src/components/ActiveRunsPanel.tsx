// T-Item-MultiTenant Phase 7 (2026-05-04): live list of all currently-
// active runs (server-wide, not parent-dir-scoped). Polls
// /api/swarm/active-runs every 5s. Surfaces runs the user may not be
// directly watching (e.g. a forward-chain that fired in a different
// tab) so they can navigate to them or stop them.
//
// Renders inline (no routing required). Per-run actions wired to the
// per-run REST routes (/api/swarm/runs/:id/stop) so stopping one run
// doesn't affect the others.
//
// When fewer than 2 runs are active OR the cap is 1, the panel
// renders nothing — single-run users keep the existing UI shape.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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
    const res = await fetch("/api/swarm/active-runs", { signal });
    if (!res.ok) return [];
    const json = (await res.json()) as ActiveRunsResponse;
    return Array.isArray(json.runs) ? json.runs : [];
  } catch {
    return [];
  }
}

async function stopRun(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/swarm/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function ActiveRunsPanel() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [now, setNow] = useState(Date.now());
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const pollRef = useRef<AbortController | null>(null);

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

  // Tick a separate state so the elapsed-time display updates per second
  // without forcing a re-fetch every second.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Hide when no active runs.
  if (runs.length < 1) return null;

  return (
    <div
      style={{
        border: "1px solid #ccc",
        borderRadius: 4,
        padding: "8px 12px",
        margin: "8px 0",
        background: "#f8f8f8",
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Active runs ({runs.length})
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#666" }}>
            <th style={{ padding: "2px 8px 2px 0" }}>Run</th>
            <th style={{ padding: "2px 8px" }}>Preset</th>
            <th style={{ padding: "2px 8px" }}>Agents</th>
            <th style={{ padding: "2px 8px" }}>Progress</th>
            <th style={{ padding: "2px 8px" }}>Elapsed</th>
            <th style={{ padding: "2px 8px" }}>Status</th>
            <th style={{ padding: "2px 0" }}></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const elapsed = now - run.startedAt;
            return (
              <tr key={run.runId}>
                <td
                  style={{
                    padding: "2px 8px 2px 0",
                    fontFamily: "monospace",
                  }}
                  title={run.runId}
                >
                  {shortRunId(run.runId)}
                  {run.brainInitiated && (
                    <span style={{ marginLeft: 4, fontSize: 10, background: "#6366f1", color: "white", padding: "0 3px", borderRadius: 2 }}>Brain</span>
                  )}
                </td>
                <td style={{ padding: "2px 8px" }}>{run.runConfig.preset}</td>
                <td style={{ padding: "2px 8px" }}>
                  {run.runConfig.agentCount ?? "?"}
                </td>
                <td style={{ padding: "2px 8px" }}>
                  {run.currentAgentIndex != null
                    ? `Agent ${run.currentAgentIndex}/${run.runConfig.agentCount ?? '?'}: thinking...`
                    : "?"}
                </td>
                <td style={{ padding: "2px 8px" }}>{formatElapsed(elapsed)}</td>
                <td style={{ padding: "2px 8px" }}>
                  {run.isRunning ? "running" : "terminated"}
                </td>
                <td style={{ padding: "2px 0", display: "flex", gap: 4 }}>
                  {/* T-Item-MultiTenant Phase 9 (2026-05-04): deep-
                      link to the per-run URL. */}
                  <button
                    type="button"
                    onClick={() => navigate(`/runs/${encodeURIComponent(run.runId)}`)}
                    style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
                  >
                    view
                  </button>
                  {run.isRunning && (
                    <button
                      type="button"
                      disabled={stoppingId === run.runId}
                      onClick={async () => {
                        setStoppingId(run.runId);
                        await stopRun(run.runId);
                        // Refetch so the row's status updates without
                        // waiting for the next 5s poll.
                        const next = await fetchActiveRuns(pollRef.current?.signal);
                        setRuns(next);
                        setStoppingId(null);
                      }}
                      style={{
                        fontSize: 11,
                        padding: "1px 6px",
                        cursor: stoppingId === run.runId ? "wait" : "pointer",
                      }}
                    >
                      {stoppingId === run.runId ? "stopping…" : "stop"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
