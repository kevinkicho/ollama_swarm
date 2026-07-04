import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { RunQueuePanel } from "./RunQueuePanel";
import { MetricsOverviewPanel } from "./MetricsOverviewPanel";
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
import { useRunsList } from "../hooks/useRunsList";

interface BrainHealth {
  status: string;
  lastAnalysis: number;
  errorCount: number;
}

interface BrainActivity {
  timestamp: number;
  type: "analysis" | "proposal" | "health" | "error" | "provision";
  title: string;
  detail?: string;
  status?: "success" | "pending" | "failed";
  // Note: "patch" type was removed when self-upgrader was retired.
}

export function SystemWrapper({
  children,
  parentPath,
}: {
  children: React.ReactNode;
  parentPath?: string;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeRunId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const { runs } = useRunsList(parentPath);
  const [systemHealthy, setSystemHealthy] = useState(true);
  const [brainHealth, setBrainHealth] = useState<BrainHealth | undefined>();
  const [brainActivities, setBrainActivities] = useState<BrainActivity[]>([]);

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

  const navigate = useNavigate();

  const activeRuns = runs.filter((r) => r.isActive).length;
  const totalRuns = runs.length;
  const completedRuns = runs.filter((r) => !r.isActive && r.stopReason === "completed").length;
  const terminalRuns = runs.filter((r) => !r.isActive).length;
  const successRate = terminalRuns > 0 ? Math.round((completedRuns / terminalRuns) * 100) : 0;

  const handleViewRun = (run: RunSummaryDigest) => {
    const rid = run.runId || "";
    if (!rid) return;
    if (run.isActive || !run.endedAt) {
      navigate(`/runs/${encodeURIComponent(rid)}`);
    } else if (run.clonePath) {
      // Historical run → review mode (matches RunHistory + parseReviewParams)
      window.location.href = `/?review=${encodeURIComponent(rid)}&path=${encodeURIComponent(run.clonePath)}`;
    } else {
      navigate(`/runs/${encodeURIComponent(rid)}`);
    }
  };

  const handleStopRun = async (runId: string) => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/swarm/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
      if (!res.ok) {
        // force terminal in any per-run context
        // (this is global-ish wrapper, but helps)
      }
    } catch {
      // ignore; next poll will reflect
    }
  };

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
            value={brainHealth?.status ?? "idle"}
            color="text-violet-400"
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
              <RunQueuePanel parentPath={parentPath} onViewRun={handleViewRun} onStopRun={handleStopRun} />
              <MetricsOverviewPanel parentPath={parentPath} />
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