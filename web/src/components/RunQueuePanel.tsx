import { useEffect, useState } from "react";

interface RunSummary {
  runId: string;
  preset: string;
  startedAt: number;
  endedAt?: number;
  stopReason?: string;
  commits?: number;
  totalTodos?: number;
}

interface RunQueuePanelProps {
  onViewRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
}

export function RunQueuePanel({ onViewRun, onStopRun }: RunQueuePanelProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRuns = async () => {
      try {
        const res = await fetch("/api/swarm/runs");
        const data = await res.json();
        setRuns(data.runs ?? []);
      } catch {
        setRuns([]);
      } finally {
        setLoading(false);
      }
    };
    fetchRuns();
    const interval = setInterval(fetchRuns, 30_000);
    return () => clearInterval(interval);
  }, []);

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
          {runs.slice(0, 5).map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              onView={() => onViewRun?.(run.runId)}
              onStop={() => onStopRun?.(run.runId)}
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
  onView,
  onStop,
}: {
  run: RunSummary;
  onView: () => void;
  onStop: () => void;
}) {
  const isActive = !run.endedAt;
  const statusColor = run.stopReason === "completed"
    ? "text-emerald-400"
    : run.stopReason === "user" || run.stopReason === "crash"
    ? "text-rose-400"
    : "text-ink-400";

  return (
    <div className="flex items-center gap-2 text-xs py-1 border-b border-ink-700/50 last:border-0">
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-blue-400 animate-pulse" : "bg-ink-500"}`} />
      <span className="font-mono text-ink-300 truncate w-16">{run.runId.slice(0, 8)}</span>
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
