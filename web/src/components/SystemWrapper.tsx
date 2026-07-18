import { memo, useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { RunQueuePanel } from "./RunQueuePanel";
import { MetricsOverviewPanel } from "./MetricsOverviewPanel";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { BrainProposalsPanel } from "./BrainProposalsPanel";
import { useSwarm } from "../state/store";
// Phase 10: brain always available (unless other config).
import { RunHistoryDropdown } from "./runHistory";
import { EventLogPanel } from "./EventLogPanel";
import { apiFetch } from "../lib/apiFetch";

import { NotificationPreferences } from "./NotificationPreferences";
import { UsageWidget } from "./UsageWidget";
import { PhasePill, RuntimeTicker } from "./RunHeaderWidgets";
import { displaySwarmPhase, isActiveSwarmPhase } from "../lib/swarmPhase";
import { runQueueIsActive } from "../lib/runQueueState";
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

  // Phase 10: brain always enabled for active runs.

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await apiFetch("/api/health");
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

  const navigate = useNavigate();

  const activeRuns = runs.filter((r) => runQueueIsActive(r)).length;
  const totalRuns = runs.length;
  const completedRuns = runs.filter((r) => !r.isActive && r.stopReason === "completed").length;
  const terminalRuns = runs.filter((r) => !r.isActive).length;
  const successRate = terminalRuns > 0 ? Math.round((completedRuns / terminalRuns) * 100) : 0;

  const handleViewRun = (run: RunSummaryDigest) => {
    const rid = run.runId || "";
    if (!rid) return;
    if (runQueueIsActive(run)) {
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
      const res = await apiFetch(`/api/swarm/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
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
  const cfg = useSwarm((s) => s.runConfig);
  const clonePathForNav = cfg?.clonePath;
  const transcriptForChat = useSwarm((s) => s.transcript);
  const agentsForChat = useSwarm((s) => s.agents);
  const cfgForChat = useSwarm((s) => s.runConfig);

  // Brain state effect (always for active runs).
  useEffect(() => {
    const fetchBrainState = async () => {
      try {
        const [healthRes, activityRes] = await Promise.all([
          apiFetch("/api/swarm/brain/health"),
          apiFetch("/api/swarm/brain/activity"),
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
      if (cfgForChat?.clonePath) {
        (window as any).__currentClonePath = cfgForChat.clonePath;
      }
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
    <div className="h-full flex flex-col min-w-0 overflow-x-hidden">
      <header className="relative z-20 px-3 sm:px-4 py-2 border-b border-ink-700 flex items-center justify-between gap-2 min-w-0 overflow-hidden bg-ink-900">
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
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
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 justify-end overflow-hidden">
          <div className="hidden md:flex items-center gap-2 text-[10px] flex-wrap min-w-0 max-w-full justify-end">
            <StatusDot
              healthy={systemHealthy}
              title={
                systemHealthy
                  ? "Server OK — /api/health responded. The swarm API is reachable."
                  : "Server unreachable — /api/health failed. Runs may not start or update until the server is back."
              }
            />
            <span
              className="text-ink-400 whitespace-nowrap cursor-help"
              title={
                phase === "idle"
                  ? "Ready — no swarm run is active in this view. Start a run from the setup page or open a past run from Runs."
                  : `Current run phase: ${phase} (shown as “${displaySwarmPhase(phase)}”). Updates live from the runner over WebSocket.`
              }
            >
              {phase === "idle" ? "Ready" : displaySwarmPhase(phase)}
            </span>
            {activeRunId && (
              <span
                className="text-ink-500 font-mono whitespace-nowrap cursor-help"
                title={`Active run id (first 8 chars of UUID). Full id: ${activeRunId}. Copy from the run chip in the identity strip below.`}
              >
                · {activeRunId.slice(0, 8)}
              </span>
            )}

            <TopbarStat
              icon="▸"
              value={`${activeRuns} active`}
              color={activeRuns > 0 ? "text-blue-400" : "text-ink-500"}
              title={`${activeRuns} run(s) still in progress under scanned workspace folders (phase not completed, stopped, or failed). Polled every 15s from /api/swarm/runs.`}
            />
            <TopbarStat
              icon="📊"
              value={`${totalRuns} total`}
              color="text-ink-400"
              title={`${totalRuns} run(s) found in workspace history (active + finished). Includes other parent dirs when enabled.`}
            />
            <TopbarStat
              icon={successRate >= 70 ? "✓" : successRate >= 40 ? "!" : "✗"}
              value={`${successRate}%`}
              color={successRate >= 70 ? "text-emerald-400" : successRate >= 40 ? "text-amber-400" : "text-red-400"}
              title={`Success rate: ${completedRuns} completed ÷ ${terminalRuns} finished runs = ${successRate}%. Only terminal runs count (not still-active).`}
            />

            {/* Phase 10: brain always shown. */}
            <TopbarStat
              icon="🧠"
              value={brainHealth?.status ?? "idle"}
              color="text-violet-400"
              title={
                brainHealth
                  ? `Brain supervisor: ${brainHealth.status}. Background analysis / proposals for the workspace (see sidebar Brain Activity).`
                  : "Brain supervisor: idle — not initialized or no recent analysis. Use the Brain floating button during a run to chat."
              }
            />
          </div>

          <div className="flex items-center gap-1.5 shrink-0 pl-1 border-l border-ink-700/60">
            <UsageWidget />
            <RunHistoryDropdown parentPath={parentPath} />
            <EventLogPanel />
          </div>
        </div>
      </header>

      {/* True floating pill (fixed) for Brain chat, persists across views */}
      {/* Phase 10: brain always available for active runs. */}
      {activeRunIdForChat && isActiveSwarmPhase(phaseForChat) && (
        <button
          type="button"
          onClick={handleOpenBrainChat}
          className="fixed bottom-20 right-4 z-40 text-[10px] px-2 py-1 rounded-full border border-violet-700/50 bg-ink-800/95 hover:bg-ink-700 text-violet-300 hover:text-violet-200 shadow-lg shadow-black/40 backdrop-blur-sm"
          title="Talk to Brain about this run"
        >
          Brain
        </button>
      )}

      <div className="flex-1 flex min-h-0">
        <aside
          className={`shrink-0 border-r border-ink-700 bg-ink-800 overflow-y-auto overflow-x-hidden transition-all duration-200 ${
            sidebarCollapsed ? "w-10" : "w-56 sm:w-64"
          }`}
        >
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-full p-2 text-[10px] text-ink-500 hover:text-ink-300 border-b border-ink-700/50"
          >
            {sidebarCollapsed ? "▸" : "◂"}
          </button>

          {!sidebarCollapsed && (
            <div className="p-2 space-y-3 min-w-0 max-w-full overflow-x-hidden">
              <SystemStatusPanel projectPath={clonePathForNav || parentPath} />
              <RunQueuePanel parentPath={parentPath} onViewRun={handleViewRun} onStopRun={handleStopRun} />
              <MetricsOverviewPanel parentPath={parentPath} />
              <BrainActivityPanel brainHealth={brainHealth} activities={brainActivities} />
              <BrainProposalsPanel clonePath={clonePathForNav || parentPath} />
              <NotificationPreferences />
            </div>
          )}
        </aside>

        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {children}
        </main>
      </div>

      {brainChatOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-3"
          onClick={() => setBrainChatOpen(false)}
        >
          <div
            className="bg-ink-800 border border-violet-700/50 rounded-lg w-full max-w-md h-[min(70vh,520px)] flex flex-col shadow-xl shadow-violet-950/20"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-ink-700/60 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] uppercase tracking-wider text-violet-400 font-semibold">
                  🧠 Brain
                </span>
                {activeRunIdForChat && (
                  <span className="text-[10px] font-mono text-ink-500 truncate">
                    {activeRunIdForChat.slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-ink-500 hover:text-ink-300"
                  title="Context: run phase, recent transcript, board todos (if blackboard)"
                  aria-label="Chat context info"
                >
                  ?
                </button>
                <button
                  type="button"
                  onClick={() => setBrainChatOpen(false)}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-ink-500 hover:text-ink-200"
                  aria-label="Close"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden px-3 py-2">
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
  title,
}: {
  icon: string;
  value: string;
  color?: string;
  title?: string;
}) {
  return (
    <span
      className={`flex items-center gap-1 whitespace-nowrap shrink-0 cursor-help ${color}`}
      title={title}
    >
      <span className="text-xs" aria-hidden>
        {icon}
      </span>
      <span>{value}</span>
    </span>
  );
}

function StatusDot({ healthy, title }: { healthy: boolean; title?: string }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 cursor-help ${
        healthy ? "bg-emerald-400" : "bg-red-400"
      }`}
      title={title}
    />
  );
}