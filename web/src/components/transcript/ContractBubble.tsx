// Phase 3 (UI coherent-fix package, 2026-04-27): structured-expand
// renderer for the planner's first-pass-contract envelope (and any
// later contract-shaped emission). Replaces the AgentJsonBubble
// fallback for this specific envelope kind so users can see ALL
// criteria with a single click instead of dropping to raw JSON.
//
// 3-tab UI:
//   Summary — first 3 criteria + "+N more (click 'All N criteria' tab)"
//   All N criteria — full numbered list with each criterion's expectedFiles
//   JSON — raw envelope for programmatic / debug use
//
// Mirrors the RunFinishedGrid / DebateVerdictBubble pattern: dedicated
// component owns its own view-mode state, renders the entry-wrapper
// data attrs are applied by the parent MessageBubble.

import { useState, type ReactNode } from "react";

interface ContractEnvelope {
  missionStatement: string;
  criteria: Array<{ description: string; expectedFiles: string[] }>;
}

const PREVIEW_COUNT = 3;
const TRUNCATE_DESC = 90;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function ContractBubble({
  envelope,
  header,
  className = "",
  style,
}: {
  envelope: ContractEnvelope;
  header: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [view, setView] = useState<"summary" | "full" | "json">("summary");
  const n = envelope.criteria.length;

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
        Contract: {truncate(envelope.missionStatement, 200)}
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
          All {n} criteri{n === 1 ? "on" : "a"}
        </button>
        <button
          className={`${tabBtnBase} ${view === "json" ? activeCls : inactiveCls}`}
          onClick={() => setView("json")}
        >
          JSON
        </button>
      </div>
      {view === "summary" && (
        <ol className="list-decimal list-inside space-y-1 text-ink-300 text-[13px]">
          {envelope.criteria.slice(0, PREVIEW_COUNT).map((c, i) => (
            <li key={i}>{truncate(c.description, TRUNCATE_DESC)}</li>
          ))}
          {n > PREVIEW_COUNT && (
            <li className="list-none italic text-ink-500 mt-1">
              …+{n - PREVIEW_COUNT} more (click <span className="text-emerald-300">All {n} criteria</span> above)
            </li>
          )}
        </ol>
      )}
      {view === "full" && (
        <ol className="list-decimal list-inside space-y-2 text-ink-200 text-[13px] overflow-y-auto" style={{ maxHeight: "600px" }}>
          {envelope.criteria.map((c, i) => (
            <li key={i} className="leading-snug">
              <span>{c.description}</span>
              {c.expectedFiles.length > 0 && (
                <div className="ml-6 text-[11px] text-ink-500 font-mono mt-0.5">
                  files: {c.expectedFiles.join(", ")}
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
