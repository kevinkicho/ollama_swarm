import { memo, useState, useEffect, useMemo } from "react";
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
import { BrainStartChat, buildRunContext, getChatContext, type RunBrainContext } from "./BrainStartChat";

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
  const [historyOpenSignal, setHistoryOpenSignal] = useState(0);

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

  const handleSwitchRun = (id: string) => {
    if (id === "history") {
      setHistoryOpenSignal((n) => n + 1);
    } else if (id) {
      // treat as runId to view
      navigate(`/runs/${encodeURIComponent(id)}`);
    }
  };

  const handleNewRun = () => {
    navigate("/");
  };

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

  // FAB + modal state for during-run Brain chat (persistent across views)
  const [brainChatOpen, setBrainChatOpen] = useState(false);
  const activeRunIdForChat = useSwarm((s) => s.runId);
  const phaseForChat = useSwarm((s) => s.phase);
  const transcriptForChat = useSwarm((s) => s.transcript);
  const agentsForChat = useSwarm((s) => s.agents);
  const cfgForChat = useSwarm((s) => s.runConfig);

  // Real board state from per-run store (todos for blackboard)
  const todosForChat = useSwarm((s: any) => s.todos || {});
  const boardCountsForChat = useMemo(() => {
    const ts = Object.values(todosForChat || {});
    return {
      open: ts.filter((t: any) => t.status === 'open').length,
      claimed: ts.filter((t: any) => t.status === 'claimed').length,
      committed: ts.filter((t: any) => t.status === 'committed').length,
      stale: ts.filter((t: any) => t.status === 'stale').length,
    };
  }, [todosForChat]);

  const [brainContext, setBrainContext] = useState<RunBrainContext | undefined>(undefined);

  // Build context using worker for perf (full integration)
  const loadChatContext = async () => {
    if (!activeRunIdForChat) return;
    const boardState = {
      counts: boardCountsForChat,
      todos: Object.values(todosForChat).slice(0, 5),
    };
    try {
      // Full worker offload via getChatContext for perf (heavy slicing/summary)
      const ctx = await getChatContext(activeRunIdForChat, {
        transcript: transcriptForChat,
        phase: phaseForChat,
        runConfig: cfgForChat,
        agents: agentsForChat,
      }, boardState);
      setBrainContext(ctx);
    } catch {
      // fallback sync
      const ctx = buildRunContext(activeRunIdForChat, { // note: import fallback if needed
        transcript: transcriptForChat,
        phase: phaseForChat,
        runConfig: cfgForChat,
        agents: agentsForChat,
      }, boardState);
      setBrainContext(ctx);
    }
  };

  const handleOpenBrainChat = async () => {
    if (activeRunIdForChat) {
      await loadChatContext();
      setBrainChatOpen(true);
    } else {
      alert('Brain chat during run requires an active run. Use setup page for new runs.');
    }
  };

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-2 border-b border-ink-700 flex items-center justify-between bg-ink-900">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-sm font-semibold text-ink-200 hover:text-ink-100 transition-colors focus:outline-none focus:ring-1 focus:ring-ink-600 rounded px-0.5 -mx-0.5"
            title="Return to home / setup"
          >
            ollama_swarm
          </button>
          <RuntimeTicker />
          <PhasePill />
          {/* Dev perf: react-scan for live run re-render measurements. Call window.enableReactScan() or ?scan=1 */}
          {typeof window !== 'undefined' && (import.meta as any)?.env?.DEV && (
            <button
              onClick={() => (window as any).enableReactScan?.()}
              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-700/50 hover:bg-amber-800"
              title="Enable react-scan overlay to measure component re-renders on this live run"
            >
              scan
            </button>
          )}
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
          <RunHistoryDropdown parentPath={parentPath} forceOpenSignal={historyOpenSignal} />
          <EventLogPanel />
        </div>
      </header>

      {/* True floating pill (fixed) for Brain chat, persists across views */}
      {activeRunIdForChat && phaseForChat !== 'idle' && (
        <button
          onClick={handleOpenBrainChat}
          className="fixed bottom-4 right-4 z-40 px-4 py-2 rounded-full bg-violet-700 hover:bg-violet-600 text-white shadow-lg flex items-center gap-2 text-sm font-medium border border-violet-500"
          title="Talk to Brain about this run (persistent)"
        >
          <span>🧠</span>
          <span>Brain</span>
        </button>
      )}

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
              <QuickNavPanel activeRunId={activeRunId} onSwitchRun={handleSwitchRun} onNewRun={handleNewRun} />
              <SystemHealthDashboard />
              <NotificationPreferences />
            </div>
          )}
        </aside>

        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {children}
        </main>
      </div>

      {/* Brain Chat Modal - prototype for persistent during-run access */}
      {brainChatOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setBrainChatOpen(false)}>
          <div 
            className="bg-ink-900 border border-violet-700 rounded-xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-ink-700">
              <div className="flex items-center gap-2">
                <span className="text-violet-400">🧠</span>
                <span className="font-semibold">Brain Assistant {activeRunIdForChat ? `(run ${activeRunIdForChat.slice(0,8)})` : ''}</span>
                <button
                  type="button"
                  className="ml-1 text-[10px] leading-none text-ink-500 hover:text-violet-400 transition-opacity opacity-50 hover:opacity-100 px-0.5"
                  title="Context includes run state, recent transcript summary, board info (if available). Ask about current progress, amendments, research insights, etc."
                  aria-label="Chat context info"
                >
                  ⓘ
                </button>
              </div>
              <button onClick={() => setBrainChatOpen(false)} className="text-ink-400 hover:text-white">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <BrainStartChat 
                onApplyConfig={() => {}} 
                onStartNow={() => {}}
                runContext={brainContext}
              />
            </div>
          </div>
        </div>
      )}
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