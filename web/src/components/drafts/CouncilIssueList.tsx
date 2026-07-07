import { severityCounts, type CouncilIssue } from "./councilDraftParse";

export function severityClass(severity?: string): string {
  switch (severity) {
    case "high":
      return "bg-rose-950/50 text-rose-300 border-rose-800/60";
    case "medium":
      return "bg-amber-950/50 text-amber-300 border-amber-800/60";
    case "low":
      return "bg-ink-800/80 text-ink-400 border-ink-700";
    default:
      return "bg-ink-800/60 text-ink-400 border-ink-700";
  }
}

export function CouncilIssueList({
  issues,
  expanded,
  onToggle,
}: {
  issues: CouncilIssue[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const previewCount = 2;
  const shown = expanded ? issues : issues.slice(0, previewCount);
  const counts = severityCounts(issues);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {Object.entries(counts).map(([sev, n]) => (
          <span
            key={sev}
            className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass(sev)}`}
          >
            {sev} {n}
          </span>
        ))}
      </div>
      <ul className="space-y-1.5">
        {shown.map((item, i) => (
          <li
            key={i}
            className="rounded border border-ink-700/80 bg-ink-950/40 p-1.5 space-y-0.5"
          >
            {item.file ? (
              <div className="font-mono text-[10px] text-sky-300/90 truncate" title={item.file}>
                {item.file}
              </div>
            ) : null}
            <p className="text-[11px] text-ink-200 leading-snug line-clamp-3">{item.issue}</p>
            {item.suggestion && expanded ? (
              <p className="text-[10px] text-ink-500 leading-snug border-t border-ink-800/80 pt-1 mt-1">
                {item.suggestion}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {issues.length > previewCount ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="text-[10px] text-ink-400 hover:text-ink-200 underline"
        >
          {expanded ? "Show fewer" : `+${issues.length - previewCount} more issue${issues.length - previewCount === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}