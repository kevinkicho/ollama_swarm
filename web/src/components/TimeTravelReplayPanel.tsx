// #90 (2026-05-01): time-travel replay UI. Routed via ?replay=<runId>.
//
// Loads /api/v2/event-log/runs/:runId once, then lets the user scrub
// backwards/forwards through records via a slider. Each scrub position
// folds records[0..cursor] into a snapshot via reduceToSnapshot and
// renders the transcript + agent grid + phase as they would have
// appeared at that tick.
//
// Pure debug tool — never replaces live state, never writes anything,
// never touches the WS. Mirrors the EventLogMirrorPanel pattern from
// the V2 6c foundation slice.

import { useReplayState } from "../hooks/useReplayState";

function pickRunIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("replay");
}

function fmtTs(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toISOString().slice(11, 19);
}

function fmtElapsed(startMs: number | null, endMs: number | null): string {
  if (startMs === null) return "—";
  const end = endMs ?? Date.now();
  const sec = Math.round((end - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function TimeTravelReplayPanel() {
  const runId = pickRunIdFromUrl();
  const { loading, error, totalRecords, cursor, setCursor, snapshot, records } =
    useReplayState(runId);

  if (!runId) {
    return (
      <div className="min-h-full bg-ink-950 text-ink-200 p-6">
        <h1 className="text-lg font-semibold mb-3">Time-travel replay</h1>
        <p className="text-sm text-ink-400">
          Pass <code className="font-mono bg-ink-900 px-1 py-0.5 rounded">?replay=&lt;runId&gt;</code>{" "}
          in the URL to load a run.
        </p>
        <p className="text-xs text-ink-500 mt-2">
          The runId comes from <code className="font-mono">/api/v2/event-log/runs</code> or the
          IdentityStrip's run-uuid chip in any prior run.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-full bg-ink-950 text-ink-200 p-6">
        Loading event log for run {runId.slice(0, 12)}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-full bg-ink-950 text-ink-200 p-6">
        <h1 className="text-lg font-semibold text-rose-300 mb-2">Replay failed</h1>
        <p className="text-sm text-ink-400">runId: {runId}</p>
        <p className="text-sm text-rose-200 mt-2">{error}</p>
      </div>
    );
  }

  const currentRecord = cursor > 0 ? records[cursor - 1] : null;
  const eventTypeCounts = new Map<string, number>();
  for (const r of records.slice(0, cursor)) {
    eventTypeCounts.set(r.event.type, (eventTypeCounts.get(r.event.type) ?? 0) + 1);
  }

  return (
    <div className="min-h-full bg-ink-950 text-ink-200 p-6 overflow-auto">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Time-travel replay</h1>
        <div className="text-xs text-ink-400 mt-1">
          runId: <code className="font-mono">{runId}</code> ·{" "}
          {totalRecords} records · derived from{" "}
          <code className="font-mono">/api/v2/event-log/runs/:runId</code>
        </div>
      </header>

      {/* Scrubber */}
      <section className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <button
            type="button"
            className="px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded text-xs"
            onClick={() => setCursor(Math.max(0, cursor - 1))}
            disabled={cursor === 0}
          >
            ← step
          </button>
          <input
            type="range"
            min={0}
            max={totalRecords}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            className="flex-1"
          />
          <button
            type="button"
            className="px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded text-xs"
            onClick={() => setCursor(Math.min(totalRecords, cursor + 1))}
            disabled={cursor === totalRecords}
          >
            step →
          </button>
          <span className="font-mono text-xs text-ink-300 w-32 text-right">
            tick {cursor} / {totalRecords}
          </span>
        </div>
        {currentRecord && (
          <div className="text-xs font-mono text-ink-400 bg-ink-900/40 border border-ink-800 rounded p-2">
            <div>
              <span className="text-ink-500">last event:</span>{" "}
              <span className="text-emerald-200">{currentRecord.event.type}</span> at{" "}
              {fmtTs(currentRecord.ts)}
            </div>
            <div className="mt-1 text-ink-500 truncate">
              {JSON.stringify(currentRecord.event).slice(0, 200)}
            </div>
          </div>
        )}
      </section>

      {/* Snapshot summary */}
      <section className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <Cell label="phase" value={snapshot.phase} />
        <Cell label="preset" value={snapshot.preset ?? "—"} />
        <Cell label="model" value={snapshot.model ?? "—"} />
        <Cell label="elapsed" value={fmtElapsed(snapshot.startedAt, snapshot.finishedAt)} />
        <Cell label="transcript entries" value={snapshot.transcript.length} />
        <Cell label="agents seen" value={snapshot.agents.length} />
        <Cell label="started" value={fmtTs(snapshot.startedAt)} />
        <Cell label="terminal?" value={snapshot.hasSummary ? "yes" : "no"} />
      </section>

      {/* Agent grid */}
      <section className="mb-6">
        <h2 className="text-sm uppercase tracking-wide text-ink-400 mb-2">
          Agents at this tick ({snapshot.agents.length})
        </h2>
        {snapshot.agents.length === 0 ? (
          <p className="text-xs text-ink-500">No agent_state events yet.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {snapshot.agents.map((a) => (
              <div
                key={a.id}
                className="bg-ink-900/60 border border-ink-700/60 rounded p-2 text-xs font-mono"
              >
                <div className="text-ink-200">{a.id}</div>
                <div className="text-ink-400">
                  idx={a.index ?? "?"} · {a.status ?? "?"}
                </div>
                {a.model && <div className="text-ink-500 truncate">{a.model}</div>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Transcript */}
      <section className="mb-6">
        <h2 className="text-sm uppercase tracking-wide text-ink-400 mb-2">
          Transcript at this tick ({snapshot.transcript.length})
        </h2>
        {snapshot.transcript.length === 0 ? (
          <p className="text-xs text-ink-500">No transcript_append events yet.</p>
        ) : (
          <ol className="space-y-2 text-xs font-mono max-h-96 overflow-auto">
            {snapshot.transcript.map((e) => (
              <li
                key={e.id}
                className="bg-ink-900/40 border border-ink-800 rounded p-2"
                data-replay-entry-id={e.id}
                data-replay-entry-role={e.role}
              >
                <div className="text-ink-400 mb-1">
                  <span className="text-emerald-300">{e.role}</span>
                  {e.agentId && <> · {e.agentId}</>}
                  {" · "}
                  {fmtTs(e.ts)}
                </div>
                <div className="text-ink-200 whitespace-pre-wrap">{e.text.slice(0, 600)}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Event-type histogram */}
      <details className="border border-ink-800 rounded p-3 bg-ink-900/40">
        <summary className="text-sm cursor-pointer text-ink-300">
          Event-type histogram (records 0..{cursor})
        </summary>
        <table className="text-xs font-mono mt-3">
          <thead>
            <tr className="text-ink-500">
              <th className="text-left pr-4 pb-1">event type</th>
              <th className="text-right pb-1">count</th>
            </tr>
          </thead>
          <tbody>
            {[...eventTypeCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => (
                <tr key={t} className="text-ink-300">
                  <td className="pr-4 py-0.5">{t}</td>
                  <td className="text-right py-0.5">{n}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-ink-900/60 border border-ink-700/60 rounded p-2">
      <div className="text-xs uppercase tracking-wide text-ink-500">{label}</div>
      <div className="font-mono text-ink-200 mt-1">{value}</div>
    </div>
  );
}
