import React from "react";
import type { RunSummaryDigest } from "../../types";

export function RunsAggregateDashboard({ runs }: { runs: RunSummaryDigest[] }) {
  // Group by preset (collapsing variants with same key)
  const byPreset = new Map<
    string,
    { total: number; completed: number; wallSum: number; wallCount: number; commits: number }
  >();
  for (const r of runs) {
    if (r.isActive) continue; // exclude in-flight from the aggregate
    const existing = byPreset.get(r.preset) ?? { total: 0, completed: 0, wallSum: 0, wallCount: 0, commits: 0 };
    existing.total += 1;
    if (r.stopReason === "completed") existing.completed += 1;
    if (typeof r.wallClockMs === "number" && r.wallClockMs > 0) {
      existing.wallSum += r.wallClockMs;
      existing.wallCount += 1;
    }
    existing.commits += r.commits ?? 0;
    byPreset.set(r.preset, existing);
  }
  if (byPreset.size === 0) return null;
  const rows = [...byPreset.entries()]
    .map(([preset, agg]) => ({
      preset,
      total: agg.total,
      completed: agg.completed,
      successRate: agg.total > 0 ? agg.completed / agg.total : 0,
      meanWallMs: agg.wallCount > 0 ? agg.wallSum / agg.wallCount : 0,
      commits: agg.commits,
    }))
    .sort((a, b) => b.total - a.total);
  const totalRuns = rows.reduce((acc, r) => acc + r.total, 0);
  return (
    <div className="px-3 pt-3 pb-2 border-b border-ink-700 bg-ink-800/40">
      <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-2">
        Aggregate · {totalRuns} historical runs across {rows.length} preset{rows.length === 1 ? "" : "s"}
      </div>
      <div className="grid grid-cols-[100px_50px_120px_70px_50px] gap-x-3 gap-y-1 text-[11px] font-mono">
        <span className="text-ink-500 text-[9px] uppercase">Preset</span>
        <span className="text-ink-500 text-[9px] uppercase text-right">Runs</span>
        <span className="text-ink-500 text-[9px] uppercase">Success rate</span>
        <span className="text-ink-500 text-[9px] uppercase text-right">Mean wall</span>
        <span className="text-ink-500 text-[9px] uppercase text-right">Commits</span>
        {rows.map((row) => {
          const ratePct = Math.round(row.successRate * 100);
          const wallSec = Math.round(row.meanWallMs / 1000);
          const wallFmt = wallSec < 60 ? `${wallSec}s` : `${Math.floor(wallSec / 60)}m${(wallSec % 60).toString().padStart(2, "0")}s`;
          const barColor = ratePct >= 80 ? "bg-emerald-500" : ratePct >= 50 ? "bg-amber-500" : "bg-rose-500";
          return (
            <React.Fragment key={row.preset}>
              <span className="text-ink-200 truncate" title={row.preset}>
                {row.preset}
              </span>
              <span className="text-ink-300 text-right tabular-nums">{row.total}</span>
              <span className="flex items-center gap-1.5">
                <div className="flex-1 h-1.5 bg-ink-900 rounded overflow-hidden min-w-[40px]">
                  <div className={`h-full ${barColor}`} style={{ width: `${ratePct}%` }} />
                </div>
                <span className="text-ink-300 text-[10px] tabular-nums w-8 text-right">{ratePct}%</span>
              </span>
              <span className="text-ink-300 text-right tabular-nums">{wallFmt}</span>
              <span className="text-ink-300 text-right tabular-nums">{row.commits}</span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
