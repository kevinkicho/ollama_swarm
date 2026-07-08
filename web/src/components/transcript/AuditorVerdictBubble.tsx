// Structured-expand renderer for auditor {verdicts, newCriteria?}.
// Compact by default (like WorkerHunksBubble): one summary line + expand.

import { memo, useState, type ReactNode } from "react";

interface AuditorEnvelope {
  verdicts: Array<{
    id: string;
    status: string;
    rationale: string;
    todos?: unknown[];
  }>;
  newCriteria?: Array<{ description: string; expectedFiles: string[] }>;
}

const TRUNCATE_RATIONALE = 120;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function statusColor(status: string): string {
  if (status === "met") return "text-emerald-300";
  if (status === "wont-do") return "text-ink-400";
  if (status === "unmet") return "text-amber-300";
  return "text-rose-300";
}

function buildSummaryLine(envelope: AuditorEnvelope): string {
  const n = envelope.verdicts.length;
  const met = envelope.verdicts.filter((v) => v.status === "met").length;
  const unmet = envelope.verdicts.filter((v) => v.status === "unmet").length;
  const wontDo = envelope.verdicts.filter((v) => v.status === "wont-do").length;
  const newN = envelope.newCriteria?.length ?? 0;
  const parts = [
    met > 0 ? `${met} met` : null,
    unmet > 0 ? `${unmet} unmet` : null,
    wontDo > 0 ? `${wontDo} wont-do` : null,
    n === 0 ? "0 verdicts" : null,
    newN > 0 ? `+${newN} new criteria` : null,
  ].filter(Boolean);
  return `Audit: ${parts.join(", ")}`;
}

export const AuditorVerdictBubble = memo(function AuditorVerdictBubble({
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
  const [expanded, setExpanded] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const n = envelope.verdicts.length;
  const summaryLine = buildSummaryLine(envelope);

  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1">{header}</div>
        <div className="flex flex-wrap items-center gap-2 shrink-0 justify-end">
          {n > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
            >
              {expanded ? "Hide verdicts" : `All ${n} verdict${n === 1 ? "" : "s"}`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
          >
            {showJson ? "Hide JSON" : "View JSON"}
          </button>
        </div>
      </div>
      <div className="text-ink-400 text-[11px] truncate mb-0.5">{summaryLine}</div>
      {expanded ? (
        <div className="mt-2 space-y-1.5 text-[13px] overflow-y-auto border-t border-ink-700/50 pt-2" style={{ maxHeight: "24rem" }}>
          {envelope.verdicts.map((v) => (
            <div key={v.id} className="flex items-baseline gap-2 min-w-0">
              <span className="font-mono text-ink-500 shrink-0">{v.id}</span>
              <span className={`shrink-0 ${statusColor(v.status)}`}>{v.status}</span>
              <span className="text-ink-400 truncate" title={v.rationale}>
                — {truncate(v.rationale, TRUNCATE_RATIONALE)}
              </span>
            </div>
          ))}
          {envelope.newCriteria && envelope.newCriteria.length > 0 ? (
            <div className="mt-2 pt-2 border-t border-ink-700/50">
              <div className="text-sky-300 mb-1 text-[10px] uppercase tracking-wide">
                {envelope.newCriteria.length} new criteri{envelope.newCriteria.length === 1 ? "on" : "a"}
              </div>
              <ol className="list-decimal list-inside text-ink-300 space-y-0.5">
                {envelope.newCriteria.map((c, i) => (
                  <li key={i} className="truncate" title={c.description}>
                    {c.description}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}
      {showJson ? (
        <pre className="mt-2 text-[11px] font-mono text-ink-300 whitespace-pre-wrap break-all rounded border border-ink-700 bg-ink-950 p-2 overflow-auto" style={{ maxHeight: "24rem" }}>
          {JSON.stringify(envelope, null, 2)}
        </pre>
      ) : null}
    </div>
  );
});