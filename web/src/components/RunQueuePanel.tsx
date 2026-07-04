import type { RunSummaryDigest } from "../types";
import { useRunsList } from "../hooks/useRunsList";
import { useSwarm } from "../state/store";

interface RunQueuePanelProps {
  parentPath?: string;
  onViewRun?: (run: RunSummaryDigest) => void;
  onStopRun?: (runId: string) => void;
}

export function RunQueuePanel({ parentPath, onViewRun, onStopRun }: RunQueuePanelProps) {
  const { runs, loading } = useRunsList(parentPath);
  const currentRunId = useSwarm((s) => s.runId);

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
        Run Queue
      </div>
      {loading ? (
        <div className="text-ink-400 text-xs">Loading...</div>
      ) : runs.length === 0 ? (
        <div className="text-ink-500 text-xs">No runs yet</div>
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
            <div className="text-[10px] text-ink-500 text-center">
              +{runs.length - 5} more runs
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const statusColor = run.stopReason === "completed"
    ? "text-emerald-400"
    : run.stopReason === "user" || run.stopReason === "crash"
    ? "text-rose-400"
    : "text-ink-400";

  return (
    <div className={`flex items-center gap-2 text-xs py-1 border-b border-ink-700/50 last:border-0 ${isCurrent ? "bg-ink-900/60 rounded" : ""}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-blue-400 animate-pulse" : "bg-ink-500"}`} />
      <span className="font-mono text-ink-300 truncate w-16">{(run.runId || "—").slice(0, 8)}</span>
      <span className="text-ink-500 truncate w-16">{run.preset}</span>
      <span className={`${statusColor} truncate`}>
        {run.stopReason ?? (isActive ? "active" : "?")}
      </span>
      <div className="ml-auto flex gap-1">
        <button
          onClick={onView}
          className="text-[9px] px-1 py-0.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-300"
        >
          View
        </button>
        {isActive && onStop && (
          <button
            onClick={onStop}
            className="text-[9px] px-1 py-0.5 rounded bg-rose-900/50 hover:bg-rose-800/50 text-rose-300"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
