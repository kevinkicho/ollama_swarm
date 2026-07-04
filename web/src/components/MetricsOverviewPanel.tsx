import type { RunSummaryDigest } from "../types";
import { useRunsList } from "../hooks/useRunsList";

interface MetricsOverviewPanelProps {
  className?: string;
  parentPath?: string;
}

export function MetricsOverviewPanel({ className = "", parentPath }: MetricsOverviewPanelProps) {
  const { runs, loading } = useRunsList(parentPath);

  const metrics = computeMetrics(runs);

  return (
    <div className={`rounded border border-ink-700 bg-ink-800 p-3 space-y-2 ${className}`}>
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
        System Metrics
      </div>
      {loading ? (
        <div className="text-ink-400 text-xs">Loading...</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Total Runs" value={metrics.totalRuns.toString()} />
          <MetricCard
            label="Success Rate"
            value={`${metrics.successRate}%`}
            color={metrics.successRate >= 70 ? "text-emerald-400" : metrics.successRate >= 40 ? "text-amber-400" : "text-red-400"}
          />
          <MetricCard label="Avg Duration" value={metrics.avgDuration} />
          <MetricCard label="Total Runs (7d)" value={metrics.recentRuns.toString()} />
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  color = "text-ink-200",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded bg-ink-900/50 p-2">
      <div className="text-[9px] text-ink-500 uppercase">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function computeMetrics(runs: RunSummaryDigest[]) {
  if (runs.length === 0) {
    return { totalRuns: 0, successRate: 0, avgDuration: "—", recentRuns: 0 };
  }

  const totalRuns = runs.length;
  const terminal = runs.filter((r) => !r.isActive && r.endedAt);
  const completed = terminal.filter((r) => r.stopReason === "completed").length;
  const successRate = terminal.length > 0 ? Math.round((completed / terminal.length) * 100) : 0;

  const totalDuration = runs.reduce((sum, r) => sum + (r.wallClockMs ?? 0), 0);
  const avgMs = totalRuns > 0 ? totalDuration / totalRuns : 0;
  const avgDuration = formatDuration(avgMs);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentRuns = runs.filter((r) => r.startedAt > sevenDaysAgo).length;

  return { totalRuns, successRate, avgDuration, recentRuns };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
