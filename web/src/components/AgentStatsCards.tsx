import type { ReactNode } from "react";
import type { PerAgentStat } from "../types";
import { fmtMs } from "./runHistory";
import { rowsFromPerAgentStats, type AgentStatsRow } from "./AgentStatsTable";

/** Narrow sidebar layout — one card per agent, only stats that have values. */
export function AgentStatsCards({
  agents,
  preset,
  label = "Final agent stats",
}: {
  agents: readonly PerAgentStat[];
  preset: string;
  label?: string;
}) {
  if (agents.length === 0) return null;
  const rows = rowsFromPerAgentStats(agents, preset);
  return (
    <>
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mt-2 mb-1">
        {label}
      </div>
      {rows.map((row, idx) => (
        <AgentStatCard key={row.agentIndex || idx} row={row} />
      ))}
    </>
  );
}

function AgentStatCard({ row }: { row: AgentStatsRow }) {
  const lines = (row.linesAdded ?? 0) + (row.linesRemoved ?? 0);
  const items: Array<{ label: string; value: ReactNode; highlight?: string }> = [
    { label: "turns", value: row.turns },
  ];
  if (row.attempts != null && row.attempts > 0) {
    items.push({ label: "attempts", value: row.attempts });
  }
  if (row.retries != null && row.retries > 0) {
    items.push({ label: "retries", value: row.retries, highlight: "text-amber-300" });
  }
  if (row.meanLatencyMs != null && row.meanLatencyMs > 0) {
    items.push({ label: "mean", value: fmtMs(row.meanLatencyMs) });
  }
  if (row.commits != null && row.commits > 0) {
    items.push({ label: "commits", value: row.commits, highlight: "text-emerald-300" });
  }
  if (lines > 0) {
    items.push({
      label: "lines",
      value: (
        <>
          <span className="text-emerald-300">+{row.linesAdded ?? 0}</span>{" "}
          <span className="text-rose-300">−{row.linesRemoved ?? 0}</span>
        </>
      ),
    });
  }
  if (row.rejected != null && row.rejected > 0) {
    items.push({ label: "rejected", value: row.rejected, highlight: "text-rose-300" });
  }
  if (row.promptErrors != null && row.promptErrors > 0) {
    items.push({ label: "errors", value: row.promptErrors, highlight: "text-rose-300" });
  }

  return (
    <div className="rounded border border-ink-700 bg-ink-800/50 p-2 text-xs mb-1.5">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-ink-100 font-semibold">agent-{row.agentIndex}</span>
        <span className="text-[10px] text-ink-400 font-mono">{row.role}</span>
      </div>
      <div className="text-[10px] font-mono text-ink-300 grid grid-cols-2 gap-x-2 gap-y-0.5">
        {items.map((item) => (
          <StatCell key={item.label} label={item.label} value={item.value} highlight={item.highlight} />
        ))}
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  highlight,
}: {
  label: string;
  value: ReactNode;
  highlight?: string;
}) {
  return (
    <>
      <span className="text-ink-500">{label}</span>
      <span className={`text-right ${highlight ?? ""}`}>{value}</span>
    </>
  );
}