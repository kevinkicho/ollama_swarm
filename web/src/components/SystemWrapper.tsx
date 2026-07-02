import { useState, useEffect } from "react";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { RunQueuePanel } from "./RunQueuePanel";
import { MetricsOverviewPanel } from "./MetricsOverviewPanel";
import { PatchMonitorPanel } from "./PatchMonitorPanel";
import { BrainProposalsPanel } from "./BrainProposalsPanel";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { QuickNavPanel } from "./QuickNavPanel";
import { useSwarm } from "../state/store";
import { RunHistoryDropdown } from "./RunHistory";
import { EventLogPanel } from "./EventLogPanel";
import SystemHealthDashboard from "./SystemHealthDashboard";
import { NotificationPreferences } from "./NotificationPreferences";
import { UsageWidget } from "./UsageWidget";
import { PhasePill, RuntimeTicker } from "./RunHeaderWidgets";
import type { RunSummaryDigest } from "../types";

interface BrainHealth {
  status: string;
  lastAnalysis: number;
  proposalCount: number;
  errorCount: number;
}

interface BrainActivity {
  timestamp: number;
  type: "analysis" | "proposal" | "patch" | "health" | "error" | "provision";
  title: string;
  detail?: string;
  status?: "success" | "pending" | "failed";
}

export function SystemWrapper({
  children,
  parentPath,
}: {
  children: React.ReactNode;
  parentPath?: string;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const brainProposals = useSwarm((s) => s.brainProposals);
  const activeRunId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const [runs, setRuns] = useState<RunSummaryDigest[]>([]);
  const [systemHealthy, setSystemHealthy] = useState(true);
  const [brainHealth, setBrainHealth] = useState<BrainHealth | undefined>();
  const [brainActivities, setBrainActivities] = useState<BrainActivity[]>([]);

  useEffect(() => {
    const fetchRuns = async () => {
      try {
        const params = new URLSearchParams();
        if (parentPath) params.set("parentPath", parentPath);
        const qs = params.toString();
        const res = await fetch(`/api/swarm/runs${qs ? `?${qs}` : ""}`);
        const data = await res.json();
        const list = Array.isArray(data.runs) ? (data.runs as RunSummaryDigest[]) : [];
        setRuns(list);
      } catch { /* ignore */ }
    };
    fetchRuns();
    const interval = setInterval(fetchRuns, 30_000);
    return () => clearInterval(interval);
  }, [parentPath]);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/health");
        const data = (await res.json()) as { ok?: boolean };
        setSystemHealthy(data.ok === true);
      } catch {
        setSystemHealthy(false);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchBrainState = async () => {
      try {
        const [healthRes, activityRes] = await Promise.all([
          fetch("/api/swarm/brain/health"),
          fetch("/api/swarm/brain/activity"),
        ]);
        const healthData = await healthRes.json();
        if (healthData.status === "not-initialized") {
          setBrainHealth(undefined);
        } else {
          setBrainHealth(healthData as BrainHealth);
        }
        const activityData = await activityRes.json();
        setBrainActivities(
          Array.isArray(activityData.activities) ? activityData.activities as BrainActivity[] : [],
        );
      } catch {
        setBrainHealth(undefined);
        setBrainActivities([]);
      }
    };
    fetchBrainState();
    const interval = setInterval(fetchBrainState, 15_000);
    return () => clearInterval(interval);
  }, []);

  const activeRuns = runs.filter((r) => r.isActive).length;
  const totalRuns = runs.length;
  const completedRuns = runs.filter((r) => !r.isActive && r.stopReason === "completed").length;
  const terminalRuns = runs.filter((r) => !r.isActive).length;
  const successRate = terminalRuns > 0 ? Math.round((completedRuns / terminalRuns) * 100) : 0;

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-2 border-b border-ink-700 flex items-center justify-between bg-ink-900">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-ink-200">ollama_swarm</span>
          <RuntimeTicker />
          <PhasePill />
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <StatusDot healthy={systemHealthy} />
          <span className="text-ink-400">
            {phase === "idle" ? "Ready" : phase}
          </span>
          {activeRunId && (
            <span className="text-ink-500 font-mono">
              · {activeRunId.slice(0, 8)}
            </span>
          )}

          <span className="text-ink-700">|</span>

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

          <span className="text-ink-700">|</span>

          <TopbarStat
            icon="🧠"
            value={brainProposals.length > 0 ? `${brainProposals.length} prop` : (brainHealth?.status ?? "idle")}
            color={brainProposals.length > 0 ? "text-violet-400" : "text-ink-500"}
          />

          <span className="text-ink-700">|</span>

          <UsageWidget />
          <RunHistoryDropdown parentPath={parentPath} />
          <EventLogPanel />
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside
          className={`border-r border-ink-700 bg-ink-800 overflow-y-auto transition-all duration-200 ${
            sidebarCollapsed ? "w-10" : "w-60"
          }`}
        >
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
                <BrainProposalsPanel
                  proposals={brainProposals}
                  onApply={async (p) => {
                    if (!p.id) return alert("No proposal id");
                    const hunks = p.suggestedHunks || [];
                    try {
                      await fetch("/api/brain/apply", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ 
                          proposalId: p.id, 
                          patchContent: hunks.map(h => ({ file: h.file, search: h.search, replace: h.replace })),
                          clonePath: undefined // backend resolves
                        }),
                      });
                      // TODO: refresh proposals list after apply
                    } catch (e) { console.error(e); }
                  }}
                  onReject={async (p) => {
                    if (!p.id) return;
                    await fetch("/api/brain/reject", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ proposalId: p.id }),
                    });
                  }}
                />
              )}
              <BrainActivityPanel brainHealth={brainHealth} activities={brainActivities} />
              <QuickNavPanel activeRunId={activeRunId} />
              <SystemHealthDashboard />
              <NotificationPreferences />
            </div>
          )}
        </aside>

        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
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