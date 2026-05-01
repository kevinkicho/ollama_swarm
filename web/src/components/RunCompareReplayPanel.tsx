// #99 (2026-05-01): two-run side-by-side comparison panel.
//
// Routed via ?compare=<runIdA>,<runIdB>. Loads BOTH runs via the
// existing useReplayState hook (one instance per run) and renders
// their snapshots side-by-side. Supports independent scrubbers and
// optional lock-step mode (both cursors move together).
//
// The cross-run diff panel computes differences between the two
// snapshots at their current cursor positions — useful for "did the
// new schema actually improve quality vs yesterday's run?"

import { useState } from "react";
import { useReplayState, type ReplaySnapshot } from "../hooks/useReplayState";

function pickRunIdsFromUrl(): [string, string] | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("compare");
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  return [parts[0], parts[1]];
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

interface CrossRunDelta {
  field: string;
  a: string;
  b: string;
  drift: boolean;
}

function computeCrossRunDiff(a: ReplaySnapshot, b: ReplaySnapshot): CrossRunDelta[] {
  const cmp = (field: string, va: string, vb: string): CrossRunDelta => ({
    field,
    a: va,
    b: vb,
    drift: va !== vb,
  });
  return [
    cmp("phase", a.phase, b.phase),
    cmp("preset", a.preset ?? "—", b.preset ?? "—"),
    cmp("model", a.model ?? "—", b.model ?? "—"),
    cmp("transcript entries", String(a.transcript.length), String(b.transcript.length)),
    cmp("agents seen", String(a.agents.length), String(b.agents.length)),
    cmp("todos posted", String(a.todos.length), String(b.todos.length)),
    cmp(
      "todos committed",
      String(a.todos.filter((t) => t.status === "committed").length),
      String(b.todos.filter((t) => t.status === "committed").length),
    ),
    cmp(
      "todos stale",
      String(a.todos.filter((t) => t.status === "stale").length),
      String(b.todos.filter((t) => t.status === "stale").length),
    ),
    cmp("findings", String(a.findings.length), String(b.findings.length)),
    cmp("errors", String(a.errors.length), String(b.errors.length)),
    cmp(
      "conformance",
      a.conformanceScore !== null ? a.conformanceScore.toFixed(0) : "—",
      b.conformanceScore !== null ? b.conformanceScore.toFixed(0) : "—",
    ),
    cmp(
      "drift",
      a.driftScore !== null ? a.driftScore.toFixed(2) : "—",
      b.driftScore !== null ? b.driftScore.toFixed(2) : "—",
    ),
    cmp("terminal?", a.hasSummary ? "yes" : "no", b.hasSummary ? "yes" : "no"),
    cmp("elapsed", fmtElapsed(a.startedAt, a.finishedAt), fmtElapsed(b.startedAt, b.finishedAt)),
  ];
}

export function RunCompareReplayPanel() {
  const ids = pickRunIdsFromUrl();
  const [lockStep, setLockStep] = useState(false);
  const a = useReplayState(ids?.[0] ?? null);
  const b = useReplayState(ids?.[1] ?? null);

  if (!ids) {
    return (
      <div className="min-h-full bg-ink-950 text-ink-200 p-6">
        <h1 className="text-lg font-semibold mb-3">Compare two runs</h1>
        <p className="text-sm text-ink-400">
          Pass <code className="font-mono bg-ink-900 px-1 py-0.5 rounded">?compare=&lt;runIdA&gt;,&lt;runIdB&gt;</code>{" "}
          in the URL to load both. Runs are loaded from{" "}
          <code className="font-mono">/api/v2/event-log/runs/:runId</code>.
        </p>
      </div>
    );
  }

  const handleSetCursorA = (n: number) => {
    a.setCursor(n);
    if (lockStep) {
      // Mirror cursor proportionally (in case run lengths differ).
      const ratio = a.totalRecords > 0 ? n / a.totalRecords : 0;
      b.setCursor(Math.round(ratio * b.totalRecords));
    }
  };
  const handleSetCursorB = (n: number) => {
    b.setCursor(n);
    if (lockStep) {
      const ratio = b.totalRecords > 0 ? n / b.totalRecords : 0;
      a.setCursor(Math.round(ratio * a.totalRecords));
    }
  };

  const crossDiff = computeCrossRunDiff(a.snapshot, b.snapshot);
  const driftCount = crossDiff.filter((d) => d.drift).length;

  return (
    <div className="min-h-full bg-ink-950 text-ink-200 p-6 overflow-auto">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Compare two runs</h1>
        <div className="text-xs text-ink-400 mt-1 flex items-center gap-4">
          <div>
            A: <code className="font-mono">{ids[0].slice(0, 12)}</code> · {a.totalRecords} records ·{" "}
            {a.loading ? "loading…" : a.error ? `error: ${a.error}` : "ready"}
          </div>
          <div>
            B: <code className="font-mono">{ids[1].slice(0, 12)}</code> · {b.totalRecords} records ·{" "}
            {b.loading ? "loading…" : b.error ? `error: ${b.error}` : "ready"}
          </div>
          <label className="flex items-center gap-2 cursor-pointer ml-auto">
            <input
              type="checkbox"
              checked={lockStep}
              onChange={(e) => setLockStep(e.target.checked)}
            />
            <span>lock-step scrubbers (proportional)</span>
          </label>
        </div>
      </header>

      {/* Two scrubbers */}
      <section className="mb-6 grid grid-cols-2 gap-4">
        <ScrubberRow
          label="Run A"
          color="emerald"
          cursor={a.cursor}
          total={a.totalRecords}
          setCursor={handleSetCursorA}
        />
        <ScrubberRow
          label="Run B"
          color="sky"
          cursor={b.cursor}
          total={b.totalRecords}
          setCursor={handleSetCursorB}
        />
      </section>

      {/* Cross-run diff table */}
      <section className="mb-6">
        <h2 className="text-sm uppercase tracking-wide text-ink-400 mb-2">
          Cross-run comparison ({driftCount} field{driftCount === 1 ? "" : "s"} differ at this cursor)
        </h2>
        <div className="border border-ink-700 rounded overflow-hidden">
          <div className="grid grid-cols-3 text-xs uppercase tracking-wide bg-ink-900 text-ink-400 font-semibold">
            <div className="px-3 py-2">field</div>
            <div className="px-3 py-2 text-emerald-300 border-l border-ink-700">A · {ids[0].slice(0, 8)}</div>
            <div className="px-3 py-2 text-sky-300 border-l border-ink-700">B · {ids[1].slice(0, 8)}</div>
          </div>
          {crossDiff.map((d) => (
            <div
              key={d.field}
              className={`grid grid-cols-3 text-sm border-t border-ink-800 ${
                d.drift ? "bg-rose-950/30" : ""
              }`}
              data-cross-diff-field={d.field}
              data-cross-diff-drift={d.drift}
            >
              <div className="px-3 py-2 text-ink-400">{d.field}</div>
              <div className={`px-3 py-2 font-mono border-l border-ink-700 ${
                d.drift ? "text-rose-200" : "text-emerald-200"
              }`}>{d.a}</div>
              <div className={`px-3 py-2 font-mono border-l border-ink-700 ${
                d.drift ? "text-rose-200" : "text-sky-200"
              }`}>{d.b}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Side-by-side transcript previews */}
      <section className="grid grid-cols-2 gap-4">
        <TranscriptPanel label="A" color="emerald" snap={a.snapshot} cursor={a.cursor} />
        <TranscriptPanel label="B" color="sky" snap={b.snapshot} cursor={b.cursor} />
      </section>
    </div>
  );
}

function ScrubberRow({
  label,
  color,
  cursor,
  total,
  setCursor,
}: {
  label: string;
  color: "emerald" | "sky";
  cursor: number;
  total: number;
  setCursor: (n: number) => void;
}) {
  return (
    <div className="bg-ink-900/40 border border-ink-700/60 rounded p-3">
      <div className={`text-xs uppercase tracking-wide text-${color}-300 mb-1`}>{label}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded text-xs"
          onClick={() => setCursor(Math.max(0, cursor - 1))}
          disabled={cursor === 0}
        >
          ←
        </button>
        <input
          type="range"
          min={0}
          max={total}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
          className="flex-1"
        />
        <button
          type="button"
          className="px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded text-xs"
          onClick={() => setCursor(Math.min(total, cursor + 1))}
          disabled={cursor === total}
        >
          →
        </button>
        <span className="font-mono text-xs text-ink-300 w-24 text-right">
          {cursor} / {total}
        </span>
      </div>
    </div>
  );
}

function TranscriptPanel({
  label,
  color,
  snap,
  cursor,
}: {
  label: string;
  color: "emerald" | "sky";
  snap: ReplaySnapshot;
  cursor: number;
}) {
  return (
    <div className="bg-ink-900/40 border border-ink-700/60 rounded p-3">
      <div className={`text-xs uppercase tracking-wide text-${color}-300 mb-2`}>
        {label} transcript at tick {cursor} ({snap.transcript.length})
      </div>
      {snap.transcript.length === 0 ? (
        <p className="text-xs text-ink-500 italic">no entries yet</p>
      ) : (
        <ol className="space-y-1 text-xs font-mono max-h-96 overflow-auto">
          {snap.transcript.map((e) => (
            <li
              key={e.id}
              className="bg-ink-900/40 border border-ink-800 rounded p-2"
            >
              <div className="text-ink-400 mb-1">
                <span className={`text-${color}-300`}>{e.role}</span>
                {e.agentId && <> · {e.agentId}</>} · {fmtTs(e.ts)}
              </div>
              <div className="text-ink-200 whitespace-pre-wrap">{e.text.slice(0, 300)}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
