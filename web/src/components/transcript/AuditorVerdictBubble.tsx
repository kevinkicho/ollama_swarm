// Phase 3 (UI coherent-fix package, 2026-04-27): structured-expand
// renderer for the auditor's {verdicts, newCriteria?} envelope.
// Same 3-tab pattern as ContractBubble.

import { useState, type ReactNode } from "react";

interface AuditorEnvelope {
  verdicts: Array<{
    id: string;
    status: string;
    rationale: string;
    todos?: unknown[];
  }>;
  newCriteria?: Array<{ description: string; expectedFiles: string[] }>;
}

const TRUNCATE_RATIONALE = 160;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function statusColor(status: string): string {
  if (status === "met") return "text-emerald-300";
  if (status === "wont-do") return "text-ink-400";
  if (status === "unmet") return "text-amber-300";
  return "text-rose-300";
}

export function AuditorVerdictBubble({
  envelope,
  header,
  className = "",
  style,
}: {
  envelope: AuditorEnvelope;
  header: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [view, setView] = useState<"summary" | "full" | "json">("summary");
  const n = envelope.verdicts.length;
  const newN = envelope.newCriteria?.length ?? 0;
  const met = envelope.verdicts.filter((v) => v.status === "met").length;
  const unmet = envelope.verdicts.filter((v) => v.status === "unmet").length;
  const wontDo = envelope.verdicts.filter((v) => v.status === "wont-do").length;

  const tabBtnBase = "px-2 py-0.5 text-[10px] uppercase tracking-wide rounded transition";
  const activeCls = "bg-violet-900/50 text-violet-200 border border-violet-700/60";
  const inactiveCls = "text-ink-400 hover:text-ink-200 border border-transparent hover:border-ink-600/60";

  return (
    <div
      className={`rounded border-2 border-violet-700/50 bg-violet-950/15 p-3 my-2 text-sm ${className}`}
      style={style}
    >
      {header}
      <div className="text-ink-200 font-medium mb-1.5 flex flex-wrap items-baseline gap-2">
        <span>Audit:</span>
        {met > 0 && <span className="text-emerald-300">{met} met</span>}
        {unmet > 0 && <span className="text-amber-300">{unmet} unmet</span>}
        {wontDo > 0 && <span className="text-ink-400">{wontDo} wont-do</span>}
        {n === 0 && <span className="text-rose-300">0 verdicts</span>}
        {newN > 0 && <span className="text-sky-300">+{newN} new criteria</span>}
      </div>
      <div className="flex items-center gap-1 mb-2">
        <button
          className={`${tabBtnBase} ${view === "summary" ? activeCls : inactiveCls}`}
          onClick={() => setView("summary")}
        >
          Summary
        </button>
        <button
          className={`${tabBtnBase} ${view === "full" ? activeCls : inactiveCls}`}
          onClick={() => setView("full")}
        >
          All {n} verdict{n === 1 ? "" : "s"}
        </button>
        <button
          className={`${tabBtnBase} ${view === "json" ? activeCls : inactiveCls}`}
          onClick={() => setView("json")}
        >
          JSON
        </button>
      </div>
      {view === "summary" && (
        <div className="text-ink-300 text-[13px] space-y-0.5">
          {envelope.verdicts.slice(0, 3).map((v) => (
            <div key={v.id} className="flex items-baseline gap-2">
              <span className="font-mono text-ink-500">{v.id}</span>
              <span className={statusColor(v.status)}>{v.status}</span>
              <span className="text-ink-400">— {truncate(v.rationale, TRUNCATE_RATIONALE)}</span>
            </div>
          ))}
          {n > 3 && (
            <div className="italic text-ink-500 mt-1">
              …+{n - 3} more (click <span className="text-violet-300">All {n} verdicts</span> above)
            </div>
          )}
        </div>
      )}
      {view === "full" && (
        <div className="space-y-2 text-[13px] overflow-y-auto" style={{ maxHeight: "600px" }}>
          {envelope.verdicts.map((v) => (
            <div key={v.id} className="border-l-2 border-ink-700 pl-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-ink-500">{v.id}</span>
                <span className={statusColor(v.status)}>{v.status}</span>
              </div>
              <div className="text-ink-300 mt-0.5">{v.rationale || "(no rationale)"}</div>
              {v.todos && v.todos.length > 0 && (
                <div className="text-[11px] text-ink-500 mt-0.5 italic">
                  +{v.todos.length} follow-up todo{v.todos.length === 1 ? "" : "s"} (see JSON)
                </div>
              )}
            </div>
          ))}
          {envelope.newCriteria && envelope.newCriteria.length > 0 && (
            <div className="mt-3 pt-2 border-t border-ink-700">
              <div className="text-sky-300 mb-1 text-[11px] uppercase tracking-wide">
                {envelope.newCriteria.length} new criteri{envelope.newCriteria.length === 1 ? "on" : "a"}
              </div>
              <ol className="list-decimal list-inside text-ink-300 space-y-1">
                {envelope.newCriteria.map((c, i) => (
                  <li key={i}>{c.description}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
      {view === "json" && (
        <pre className="text-[11px] font-mono bg-ink-950 border border-ink-700 p-2 rounded overflow-auto" style={{ maxHeight: "600px" }}>
{JSON.stringify(envelope, null, 2)}
        </pre>
      )}
    </div>
  );
}
