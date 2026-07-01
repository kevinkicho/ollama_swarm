import { useState } from "react";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { RunQueuePanel } from "./RunQueuePanel";
import { MetricsOverviewPanel } from "./MetricsOverviewPanel";
import { PatchMonitorPanel } from "./PatchMonitorPanel";
import { BrainProposalsPanel } from "./BrainProposalsPanel";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { QuickNavPanel } from "./QuickNavPanel";
import { useSwarm } from "../state/store";

/**
 * SystemWrapper — persistent shell that wraps the entire app.
 *
 * Provides:
 * - Persistent header with system status
 * - System sidebar (visible in ALL views)
 * - Main content area for view-specific content
 *
 * This replaces the scattered system panels in SwarmView's sidebar
 * with a unified, always-visible system layer.
 */
export function SystemWrapper({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const brainProposals = useSwarm((s) => s.brainProposals);
  const activeRunId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);

  return (
    <div className="h-full flex flex-col">
      {/* Header — always visible */}
      <header className="px-4 py-2 border-b border-ink-700 flex items-center justify-between bg-ink-900">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-ink-200">🧠 ollama_swarm</span>
          <span className="text-[10px] text-ink-500">v2.0</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <StatusDot healthy={true} />
          <span className="text-ink-400">
            {phase === "idle" ? "Ready" : phase}
          </span>
          {activeRunId && (
            <span className="text-ink-500 font-mono">
              · {activeRunId.slice(0, 8)}
            </span>
          )}
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

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
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
