// Phase 3 follow-up (UI coherent-fix package, 2026-04-27 evening):
// structured-expand renderer for the planner's top-level todos envelope.
// Same 3-tab pattern as ContractBubble + AuditorVerdictBubble.
//
// Pre-fix: planner output `[{description, expectedFiles, ...}]` fell
// through to JsonPrettyBubble (raw JSON dump). Post-fix: numbered list
// with file chips per todo, expandable to show all N todos.
//
// Theme: emerald (sibling to the contract; "actionable next steps").

import { useState, type ReactNode } from "react";

interface TodosEnvelope {
  todos: Array<{ description: string; expectedFiles: string[] }>;
}

const TRUNCATE_DESC = 180;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function TodosBubble({
  envelope,
  header,
  className = "",
  style,
}: {
  envelope: TodosEnvelope;
  header: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [view, setView] = useState<"summary" | "full" | "json">("summary");
  const n = envelope.todos.length;

  const tabBtnBase = "px-2 py-0.5 text-[10px] uppercase tracking-wide rounded transition";
  const activeCls = "bg-emerald-900/50 text-emerald-200 border border-emerald-700/60";
  const inactiveCls = "text-ink-400 hover:text-ink-200 border border-transparent hover:border-ink-600/60";

  return (
    <div
      className={`rounded border-2 border-emerald-700/50 bg-emerald-950/15 p-3 my-2 text-sm ${className}`}
      style={style}
    >
      {header}
      <div className="text-ink-200 font-medium mb-1.5">
        Posted {n} todo{n === 1 ? "" : "s"} to the board
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
          All {n} todo{n === 1 ? "" : "s"}
        </button>
        <button
          className={`${tabBtnBase} ${view === "json" ? activeCls : inactiveCls}`}
          onClick={() => setView("json")}
        >
          JSON
        </button>
      </div>
      {view === "summary" && (
        <div className="text-ink-300 text-[13px] space-y-1">
          {envelope.todos.slice(0, 3).map((t, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="font-mono text-ink-500 shrink-0">{i + 1}.</span>
              <span className="text-ink-300">{truncate(t.description, TRUNCATE_DESC)}</span>
            </div>
          ))}
          {n > 3 && (
            <div className="italic text-ink-500 mt-1">
              …+{n - 3} more (click <span className="text-emerald-300">All {n} todos</span> above)
            </div>
          )}
        </div>
      )}
      {view === "full" && (
        <ol className="space-y-2 text-[13px] overflow-y-auto list-decimal list-inside" style={{ maxHeight: "600px" }}>
          {envelope.todos.map((t, i) => (
            <li key={i} className="text-ink-300">
              <span className="text-ink-200">{t.description}</span>
              {t.expectedFiles.length > 0 && (
                <div className="mt-0.5 ml-5 flex flex-wrap gap-1">
                  {t.expectedFiles.map((f, j) => (
                    <span key={j} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-800/60 text-ink-400 border border-ink-700/60">
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {view === "json" && (
        <pre className="text-[11px] font-mono bg-ink-950 border border-ink-700 p-2 rounded overflow-auto" style={{ maxHeight: "600px" }}>
{JSON.stringify(envelope, null, 2)}
        </pre>
      )}
    </div>
  );
}
