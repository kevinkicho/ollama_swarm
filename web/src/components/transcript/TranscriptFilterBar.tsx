// Transcript filter toolbar — extracted from Transcript.tsx.

import type { TranscriptFilterId } from "./transcriptFilter";

const FILTERS = ["all", "key", "system", "agents", "audit", "issues"] as const;

export function TranscriptFilterBar(props: {
  filter: TranscriptFilterId;
  onFilterChange: (f: TranscriptFilterId) => void;
  filteredCount: number;
  totalCount: number;
  runId?: string | null;
  phase?: string;
  suggesting: boolean;
  onSuggest: () => void;
}) {
  const {
    filter,
    onFilterChange,
    filteredCount,
    totalCount,
    runId,
    phase,
    suggesting,
    onSuggest,
  } = props;

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-ink-800/50 border-b border-ink-700/50 shrink-0">
      <span className="text-[10px] text-ink-500">Filter:</span>
      {FILTERS.map((f) => (
        <button
          key={f}
          onClick={() => onFilterChange(f)}
          className={`px-2 py-0.5 text-[10px] rounded ${
            filter === f
              ? "bg-ink-600 text-ink-200"
              : "text-ink-400 hover:text-ink-200 hover:bg-ink-700"
          }`}
          title={f === "key" ? "Optional: high-signal items only" : undefined}
        >
          {f === "key" ? "Key" : f.charAt(0).toUpperCase() + f.slice(1)}
        </button>
      ))}
      <span className="text-[10px] text-ink-500 ml-auto">
        {filteredCount} / {totalCount} entries
      </span>
      {runId && phase !== "completed" && phase !== "stopped" && phase !== "failed" && (
        <button
          onClick={onSuggest}
          disabled={suggesting}
          className="ml-2 px-1.5 py-px text-[9px] rounded bg-amber-800/50 hover:bg-amber-700/70 text-amber-200 border border-amber-800/60 disabled:opacity-50"
          title="Ask Brain for a proactive suggestion (injects a special 🧠 Brain suggestion entry into the live transcript)"
        >
          {suggesting ? "💡 suggesting…" : "💡 suggest"}
        </button>
      )}
    </div>
  );
}
