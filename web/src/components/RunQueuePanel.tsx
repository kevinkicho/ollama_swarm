import { memo } from "react";
import type { RunSummaryDigest } from "../types";
import { useRunsList } from "../hooks/useRunsList";
import { useSwarm } from "../state/store";

interface RunQueuePanelProps {
  parentPath?: string;
  onViewRun?: (run: RunSummaryDigest) => void;
  onStopRun?: (runId: string) => void;
}

export const RunQueuePanel = memo(function RunQueuePanel({ parentPath, onViewRun, onStopRun }: RunQueuePanelProps) {
  const { runs, loading } = useRunsList(parentPath);
  const currentRunId = useSwarm((s) => s.runId);

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-2 space-y-1 text-[10px]">
      <div className="text-[9px] uppercase tracking-wider text-ink-400 font-semibold px-0.5">
        Run Queue
      </div>
      {loading ? (
        <div className="text-ink-400 text-[9px]">Loading...</div>
      ) : runs.length === 0 ? (
        <div className="text-ink-500 text-[9px]">No runs yet</div>
      ) : (
        <div className="space-y-1">
          {[...runs]
            .sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
            .slice(0, 5)
            .map((run) => (
            <RunRow
              key={run.runId ?? run.startedAt}
              run={run}
              isCurrent={!!run.runId && run.runId === currentRunId}
              onView={() => onViewRun?.(run)}
              onStop={() => onStopRun?.(run.runId ?? "")}
            />
          ))}
          {runs.length > 5 && (
            <div className="text-[9px] text-ink-500 text-center">
              +{runs.length - 5} more
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function RunRow({
  run,
  isCurrent,
  onView,
  onStop,
}: {
  run: RunSummaryDigest;
  isCurrent?: boolean;
  onView: () => void;
  onStop: () => void;
}) {
  const isActive = run.isActive || !run.endedAt;
  const status = run.stopReason ?? (isActive ? "active" : "?");
  const statusClass = run.stopReason === "completed"
    ? "bg-emerald-900/40 text-emerald-300 border-emerald-800/50"
    : run.stopReason === "user" || run.stopReason === "crash"
    ? "bg-rose-900/40 text-rose-300 border-rose-800/50"
    : isActive
    ? "bg-blue-900/30 text-blue-300 border-blue-800/40"
    : "bg-ink-700/50 text-ink-400 border-ink-700/50";

  return (
    <div className={`flex items-center gap-1.5 text-[10px] py-0.5 border-b border-ink-700/40 last:border-0 overflow-hidden ${isCurrent ? "bg-ink-900/70 rounded" : ""}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-blue-400 animate-pulse" : "bg-ink-500"}`} />
      <span className="font-mono text-ink-300 truncate min-w-0 w-14" title={run.runId || ""}>
        {(run.runId || "—").slice(0, 8)}
      </span>
      <span className="px-1 py-px rounded bg-ink-700/60 text-ink-300 text-[9px] truncate max-w-[52px]" title={run.preset}>
        {run.preset}
      </span>
      <span className={`px-1 py-px rounded border text-[9px] truncate ${statusClass}`} title={status}>
        {status}
      </span>
      <div className="ml-auto flex gap-0.5 shrink-0">
        <button
          onClick={onView}
          className="text-[8px] px-1 py-px rounded bg-ink-700 hover:bg-ink-600 text-ink-300"
        >
          View
        </button>
        {isActive && onStop && (
          <button
            onClick={onStop}
            className="text-[8px] px-1 py-px rounded bg-rose-900/60 hover:bg-rose-800 text-rose-300"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
