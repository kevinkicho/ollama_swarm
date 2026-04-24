import { useSwarm } from "../state/store";
import type { AgentState, LatencySample } from "../types";

// Phase 1 of the tabs-per-preset brainstorm (2026-04-24): a universal
// per-agent metrics view that works across all 8 presets without
// per-preset branching. Reads from the zustand store's latency
// samples (pushed by every runner via Unit 40's agent_latency_sample
// event) and the agents map — both always populated regardless of
// preset.
//
// Surfaces what you'd otherwise have to hover the thinking-ticker
// sparkline on every card to see:
//   - attempts (success + retry)
//   - mean latency, p50, p95 (latest-20 window — matches LATENCY_WINDOW)
//   - success rate
//   - current status
//   - model
//
// Replaces the need to manually correlate the sidebar cards for
// latency asymmetry stories ("agent-3 and agent-4 are 5x slower than
// agent-1 this run").
export function MetricsPanel() {
  const agents = useSwarm((s) => s.agents);
  const latency = useSwarm((s) => s.latency);
  const cfg = useSwarm((s) => s.runConfig);
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);

  if (agentList.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No agents yet. Metrics populate once the run starts and agents produce their first prompts.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs text-ink-500 mb-2">
        Per-agent prompt metrics. Window: latest 20 samples. Updates live.
      </div>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left text-ink-500 uppercase tracking-wide text-[10px] border-b border-ink-700">
            <th className="py-1 px-2">Agent</th>
            <th className="py-1 px-2">Status</th>
            <th className="py-1 px-2 text-right">Samples</th>
            <th className="py-1 px-2 text-right">Success</th>
            <th className="py-1 px-2 text-right">Mean</th>
            <th className="py-1 px-2 text-right">p50</th>
            <th className="py-1 px-2 text-right">p95</th>
            <th className="py-1 px-2 text-right">Last</th>
            <th className="py-1 px-2">Model</th>
          </tr>
        </thead>
        <tbody>
          {agentList.map((a) => (
            <MetricsRow
              key={a.id}
              agent={a}
              samples={latency[a.id] ?? []}
              model={modelForAgent(a.index, cfg)}
            />
          ))}
        </tbody>
      </table>
      <div className="mt-6 text-xs text-ink-500">
        <p className="mb-1">
          <span className="text-ink-300">Reading this view:</span> wide gaps between
          agents' mean/p95 on the same preset usually surface the cloud queue-race
          pattern (first-spawned agents win, later-spawned agents lose).
        </p>
        <p>
          A zero-samples row means the agent hasn't completed any prompts yet —
          usually the first round hasn't landed its turn.
        </p>
      </div>
    </div>
  );
}

function MetricsRow({
  agent,
  samples,
  model,
}: {
  agent: AgentState;
  samples: readonly LatencySample[];
  model?: string;
}) {
  const stats = computeStats(samples);
  const successPct = stats.count > 0
    ? `${Math.round((stats.successCount / stats.count) * 100)}%`
    : "—";
  const successClass = stats.count > 0
    ? stats.successCount === stats.count
      ? "text-emerald-300"
      : stats.successCount > 0
        ? "text-amber-300"
        : "text-rose-300"
    : "text-ink-500";
  const statusClass = statusColor(agent.status);
  return (
    <tr className="border-b border-ink-800/60 hover:bg-ink-800/40">
      <td className="py-1 px-2 text-ink-200">agent-{agent.index}</td>
      <td className={`py-1 px-2 ${statusClass}`}>{agent.status}</td>
      <td className="py-1 px-2 text-right text-ink-300">{stats.count || "—"}</td>
      <td className={`py-1 px-2 text-right ${successClass}`}>{successPct}</td>
      <td className="py-1 px-2 text-right text-ink-300">{fmt(stats.mean)}</td>
      <td className="py-1 px-2 text-right text-ink-300">{fmt(stats.p50)}</td>
      <td className="py-1 px-2 text-right text-ink-300">{fmt(stats.p95)}</td>
      <td className="py-1 px-2 text-right text-ink-300">{fmt(stats.last)}</td>
      <td className="py-1 px-2 text-ink-400 truncate max-w-xs">{model ?? "—"}</td>
    </tr>
  );
}

function computeStats(samples: readonly LatencySample[]): {
  count: number;
  successCount: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  last: number | null;
} {
  if (samples.length === 0) {
    return { count: 0, successCount: 0, mean: null, p50: null, p95: null, last: null };
  }
  const successSamples = samples.filter((s) => s.success);
  const elapsed = successSamples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const count = samples.length;
  const successCount = successSamples.length;
  const mean =
    elapsed.length > 0
      ? elapsed.reduce((acc, v) => acc + v, 0) / elapsed.length
      : null;
  const p50 = percentile(elapsed, 50);
  const p95 = percentile(elapsed, 95);
  const last = samples[samples.length - 1]?.elapsedMs ?? null;
  return { count, successCount, mean, p50, p95, last };
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function fmt(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusColor(status: AgentState["status"]): string {
  switch (status) {
    case "ready":
      return "text-emerald-300";
    case "thinking":
      return "text-blue-300";
    case "retrying":
      return "text-amber-300";
    case "failed":
      return "text-rose-300";
    case "stopped":
      return "text-ink-400";
    case "spawning":
    default:
      return "text-ink-300";
  }
}

function modelForAgent(
  idx: number,
  cfg: ReturnType<typeof useSwarm.getState>["runConfig"],
): string | undefined {
  if (!cfg) return undefined;
  if (idx === 1) return cfg.plannerModel;
  if (cfg.dedicatedAuditor && idx > cfg.agentCount) return cfg.auditorModel;
  return cfg.workerModel;
}
