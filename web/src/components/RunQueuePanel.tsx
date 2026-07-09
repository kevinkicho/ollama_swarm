import { memo } from "react";
import type { RunSummaryDigest } from "../types";
import { useRunsList } from "../hooks/useRunsList";
import { useSwarm } from "../state/store";
import { runQueueIsActive, runQueueStatusClass, runQueueStatusLabel } from "../lib/runQueueState";

/** Preset column shrinks; actions column fixed so Stop appearing does not shift View. */
const RUN_ROW =
  "grid grid-cols-[0.5rem_2.25rem_minmax(0,1fr)_2.5rem_3.25rem] items-center gap-x-1 min-w-0 w-full max-w-full overflow-hidden";

interface RunQueuePanelProps {
  parentPath?: string;
  onViewRun?: (run: RunSummaryDigest) => void;
  onStopRun?: (runId: string) => void;
}

export const RunQueuePanel = memo(function RunQueuePanel({ parentPath, onViewRun, onStopRun }: RunQueuePanelProps) {
  const { runs, loading } = useRunsList(parentPath);
  const currentRunId = useSwarm((s) => s.runId);

  const sorted = [...runs]
    .sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 5);

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-2 space-y-1 text-[10px] min-w-0 max-w-full overflow-hidden">
      <div className="text-[9px] uppercase tracking-wider text-ink-400 font-semibold px-0.5">
        Run Queue
      </div>
      {loading ? (
        <div className="text-ink-400 text-[9px]">Loading...</div>
      ) : runs.length === 0 ? (
        <div className="text-ink-500 text-[9px]">No runs yet</div>
      ) : (
        <div className="min-w-0 max-w-full overflow-hidden space-y-0">
          {sorted.map((run) => (
            <RunRow
              key={run.runId ?? run.startedAt}
              run={run}
              isCurrent={!!run.runId && run.runId === currentRunId}
              onView={() => onViewRun?.(run)}
              onStop={() => onStopRun?.(run.runId ?? "")}
            />
          ))}
          {runs.length > 5 && (
            <div className="text-[9px] text-ink-500 text-center pt-1">
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
  const isActive = runQueueIsActive(run);
  const status = runQueueStatusLabel(run, isActive);
  const statusClass = runQueueStatusClass(run, isActive);

  return (
    <div
      className={`${RUN_ROW} py-0.5 border-b border-ink-700/40 last:border-0 ${
        isCurrent ? "bg-ink-900/70 rounded-sm" : ""
      }`}
    >
      <span className="flex items-center justify-center" aria-hidden>
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            isActive ? "bg-blue-400 animate-pulse" : "bg-ink-500"
          }`}
        />
      </span>
      <span
        className="font-mono text-ink-300 truncate leading-none min-w-0"
        title={run.runId || ""}
      >
        {(run.runId || "—").slice(0, 6)}
      </span>
      <span
        className="px-1 py-px rounded bg-ink-700/60 text-ink-300 text-[9px] truncate leading-none min-w-0"
        title={run.preset}
      >
        {run.preset}
      </span>
      <span className="min-w-0 overflow-hidden">
        <span
          className={`inline-block max-w-full px-1 py-px rounded border text-[9px] leading-none truncate ${statusClass}`}
          title={status}
        >
          {status}
        </span>
      </span>
      <div className="flex items-center justify-end gap-px w-full shrink-0">
        <button
          type="button"
          onClick={onView}
          title="View run"
          className="text-[8px] px-0.5 py-px rounded bg-ink-700 hover:bg-ink-600 text-ink-300 leading-none"
        >
          View
        </button>
        <button
          type="button"
          onClick={onStop}
          title="Stop run"
          disabled={!isActive || !onStop}
          aria-hidden={!isActive}
          tabIndex={isActive ? 0 : -1}
          className={`text-[8px] px-0.5 py-px rounded leading-none min-w-[1.65rem] ${
            isActive
              ? "bg-rose-900/60 hover:bg-rose-800 text-rose-300"
              : "invisible pointer-events-none bg-transparent text-transparent"
          }`}
        >
          Stop
        </button>
      </div>
    </div>
  );
}