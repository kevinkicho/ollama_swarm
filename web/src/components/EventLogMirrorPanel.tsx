// E2 next slice (#333): debug-only side-by-side comparison of the two
// state sources we have today:
//
//   LEFT  — WebSocket-derived store (what the live UI consumes today)
//   RIGHT — event-log-derived stream (what the cutover would switch to)
//
// Routed via ?eventLogMirror=1 so it's never shown to normal users.
// Pure visual diff — no writes, no replacement of either source. Lets
// us watch a real run and confirm the two sources agree before we
// commit to the cutover. If they ever drift, the highlighted cell is
// the first place to look.
//
// Intentionally minimal: shows the canonical fields that matter for
// "is this the same run, in the same phase, with the same counts?"
// Not exhaustive — extend as specific drift hypotheses emerge.

import { useSwarm } from "../state/store";
import { useEventLogStream } from "../hooks/useEventLogStream";
import type { EventLogRun } from "../hooks/useEventLogStream";

function pickLatestRun(runs: readonly EventLogRun[]): EventLogRun | null {
  // Server returns runs newest-last (insertion order); mirror that here.
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.derived.runId) return r;
  }
  return null;
}

function fmtAgo(ms: number | null): string {
  if (ms === null) return "—";
  const dt = Date.now() - ms;
  if (dt < 1000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  return `${Math.round(dt / 60_000)}m ago`;
}

function Cell({
  label,
  ws,
  log,
}: {
  label: string;
  ws: string | number | undefined;
  log: string | number | undefined;
}) {
  const wsStr = ws === undefined || ws === null ? "—" : String(ws);
  const logStr = log === undefined || log === null ? "—" : String(log);
  const drift = wsStr !== logStr && wsStr !== "—" && logStr !== "—";
  const cellCls = drift
    ? "bg-rose-950/40 border-rose-700/60"
    : "bg-ink-900/60 border-ink-700/60";
  return (
    <div className={`grid grid-cols-3 border ${cellCls} rounded my-1`}>
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-400 border-r border-ink-700/40">
        {label}
      </div>
      <div className={`px-3 py-2 font-mono text-sm ${drift ? "text-rose-200" : "text-emerald-200"}`}>
        {wsStr}
      </div>
      <div className={`px-3 py-2 font-mono text-sm ${drift ? "text-rose-200" : "text-sky-200"}`}>
        {logStr}
      </div>
    </div>
  );
}

export function EventLogMirrorPanel() {
  // Subscribe to both sources. Re-renders on either changing.
  const wsStore = useSwarm();
  const eventLog = useEventLogStream();

  const latestLogRun = pickLatestRun(eventLog.runs);

  return (
    <div className="min-h-full bg-ink-950 text-ink-200 p-6 overflow-auto">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Event-log mirror</h1>
        <div className="text-xs text-ink-400 mt-1">
          Side-by-side WebSocket-store ↔ event-log-stream. Mismatched cells highlight rose. Debug-only — routed via{" "}
          <code className="font-mono bg-ink-900 px-1 py-0.5 rounded">?eventLogMirror=1</code>.
        </div>
        <div className="text-xs text-ink-500 mt-1">
          event-log fetch:{" "}
          {eventLog.loading
            ? "loading…"
            : eventLog.error
              ? `error: ${eventLog.error}`
              : `${eventLog.runs.length} runs · last ${fmtAgo(eventLog.lastFetchedAt)}${
                  eventLog.malformed > 0 ? ` · ${eventLog.malformed} malformed` : ""
                }`}
        </div>
      </header>

      <div className="grid grid-cols-3 mb-2 sticky top-0 bg-ink-950 z-10">
        <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-400 font-semibold">
          field
        </div>
        <div className="px-3 py-2 text-xs uppercase tracking-wide text-emerald-300 font-semibold border-l border-ink-700/40">
          ws-store
        </div>
        <div className="px-3 py-2 text-xs uppercase tracking-wide text-sky-300 font-semibold border-l border-ink-700/40">
          event-log
        </div>
      </div>

      <Cell
        label="run id"
        ws={wsStore.runId?.slice(0, 12) ?? undefined}
        log={latestLogRun?.derived.runId?.slice(0, 12) ?? undefined}
      />
      <Cell
        label="phase / final-phase"
        ws={wsStore.phase}
        log={latestLogRun?.derived.finalPhase ?? undefined}
      />
      <Cell
        label="preset"
        ws={wsStore.runConfig?.preset}
        log={latestLogRun?.derived.preset ?? undefined}
      />
      <Cell
        label="transcript entry count"
        ws={wsStore.transcript.length}
        log={latestLogRun?.derived.transcriptCount}
      />
      <Cell
        label="agent count / state-update count"
        ws={Object.keys(wsStore.agents).length}
        log={latestLogRun?.derived.agentStateUpdates}
      />
      <Cell
        label="error present"
        ws={wsStore.error ? "yes" : "no"}
        log={(latestLogRun?.derived.errors.length ?? 0) > 0 ? "yes" : "no"}
      />
      <Cell
        label="has summary"
        ws={wsStore.summary ? "yes" : "no"}
        log={latestLogRun?.derived.hasSummary ? "yes" : "no"}
      />
      <Cell
        label="record count (event-log only)"
        ws={undefined}
        log={latestLogRun?.recordCount}
      />

      <details className="mt-6 border border-ink-700/40 rounded p-3 bg-ink-900/40">
        <summary className="cursor-pointer text-sm text-ink-300">
          Recent runs from event log ({eventLog.runs.length})
        </summary>
        <ol className="mt-3 text-xs font-mono text-ink-400 max-h-64 overflow-y-auto space-y-1">
          {eventLog.runs.slice(-20).reverse().map((r, i) => (
            <li key={i} className="border-b border-ink-800/60 py-1">
              {r.derived.runId?.slice(0, 8) ?? "(no-runId)"} · {r.derived.preset ?? "—"} ·{" "}
              {r.derived.finalPhase ?? "running"} · {r.recordCount} records
              {r.derived.errors.length > 0 ? ` · ${r.derived.errors.length} err` : ""}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
