import { useState, useEffect } from "react";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { RunQueuePanel } from "./RunQueuePanel";
import { MetricsOverviewPanel } from "./MetricsOverviewPanel";
import { PatchMonitorPanel } from "./PatchMonitorPanel";
import { BrainProposalsPanel } from "./BrainProposalsPanel";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { QuickNavPanel } from "./QuickNavPanel";
import { useSwarm } from "../state/store";

interface RunSummary {
  runId: string;
  preset: string;
  startedAt: number;
  endedAt?: number;
  stopReason?: string;
}

export function SystemWrapper({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const brainProposals = useSwarm((s) => s.brainProposals);
  const activeRunId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    const fetchRuns = async () => {
      try {
        const res = await fetch("/api/swarm/runs");
        const data = await res.json();
        setRuns(data.runs ?? []);
      } catch { /* ignore */ }
    };
    fetchRuns();
    const interval = setInterval(fetchRuns, 30_000);
    return () => clearInterval(interval);
  }, []);

  const activeRuns = runs.filter((r) => !r.endedAt).length;
  const totalRuns = runs.length;
  const completedRuns = runs.filter((r) => r.stopReason === "completed").length;
  const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header — always visible */}
      <header className="px-4 py-2 border-b border-ink-700 flex items-center justify-between bg-ink-900">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-ink-200">🧠 ollama_swarm</span>
          <span className="text-[10px] text-ink-500">v2.0</span>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          {/* Status */}
          <StatusDot healthy={true} />
          <span className="text-ink-400">
            {phase === "idle" ? "Ready" : phase}
          </span>
          {activeRunId && (
            <span className="text-ink-500 font-mono">
              · {activeRunId.slice(0, 8)}
            </span>
          )}

          {/* Separator */}
          <span className="text-ink-700">|</span>

          {/* Quick stats */}
          <TopbarStat
            icon="▸"
            value={`${activeRuns} active`}
            color={activeRuns > 0 ? "text-blue-400" : "text-ink-500"}
          />
          <TopbarStat
            icon="📊"
            value={`${totalRuns} total`}
            color="text-ink-400"
          />
          <TopbarStat
            icon={successRate >= 70 ? "✓" : successRate >= 40 ? "!" : "✗"}
            value={`${successRate}%`}
            color={successRate >= 70 ? "text-emerald-400" : successRate >= 40 ? "text-amber-400" : "text-red-400"}
          />

          {/* Separator */}
          <span className="text-ink-700">|</span>

          {/* Brain status */}
          <TopbarStat
            icon="🧠"
            value={brainProposals.length > 0 ? `${brainProposals.length} prop` : "idle"}
            color={brainProposals.length > 0 ? "text-violet-400" : "text-ink-500"}
          />
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex-1 flex min-h-0">
        {/* System sidebar — always visible */}
        <aside
          className={`border-r border-ink-700 bg-ink-800 overflow-y-auto transition-all duration-200 ${
            sidebarCollapsed ? "w-10" : "w-60"
          }`}
        >
          {/* Collapse toggle */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-full p-2 text-[10px] text-ink-500 hover:text-ink-300 border-b border-ink-700/50"
          >
            {sidebarCollapsed ? "▸" : "◂"}
          </button>

          {!sidebarCollapsed && (
            <div className="p-2 space-y-3">
              <SystemStatusPanel />
              <RunQueuePanel />
              <MetricsOverviewPanel />
              <PatchMonitorPanel />
              {brainProposals.length > 0 && (
                <BrainProposalsPanel proposals={brainProposals} />
              )}
              <BrainActivityPanel />
              <QuickNavPanel activeRunId={activeRunId} />
            </div>
          )}
        </aside>

        {/* Main content — fixed to viewport, children handle their own scrolling */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}

function TopbarStat({
  icon,
  value,
  color = "text-ink-400",
}: {
  icon: string;
  value: string;
  color?: string;
}) {
  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <span className="text-xs">{icon}</span>
      <span>{value}</span>
    </span>
  );
}

function StatusDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${
        healthy ? "bg-emerald-400" : "bg-red-400"
      }`}
    />
  );
}
