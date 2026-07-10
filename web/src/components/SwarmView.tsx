import { memo, useEffect, useState, useMemo, useContext } from "react";
import { useParams } from "react-router-dom";
import { useSwarm, SwarmStoreContext, swarmSingletonStore } from "../state/store";
// Phase 10: previous special composite/phase guards removed.
import { AgentPanel } from "./AgentPanel";
import { useNavigate } from "react-router-dom";
import { BoardView } from "./BoardView";
import { ContractPanel } from "./ContractPanel";
import { Transcript } from "./Transcript";
import { MetricsPanel } from "./MetricsPanel";
import { PheromonePanel } from "./PheromonePanel";
import { DraftMatrix } from "./DraftMatrix";
import { DraftsTabWithTooltip } from "./drafts/DraftsTabTooltip";
import { VerdictPanel } from "./VerdictPanel";
import { CoveragePanel } from "./CoveragePanel";
import { OwSubtasksPanel } from "./OwSubtasksPanel";
import { MemoryLogPanel } from "./MemoryLogPanel";
import { CloneBanner } from "./CloneBanner";
import { IdentityStrip } from "./IdentityStrip";
import { RunOutcomeBanner } from "./RunOutcomeBanner";
import { ProjectGraphPanel } from "../features/projectGrowth/ProjectGraphPanel";

import { TranscriptTimeline } from "./TranscriptTimeline";
import { PlanningTab } from "./PlanningTab";
import { OutcomeChip } from "./OutcomeChip";
import { roleForRow } from "./runHistory";
import { AgentStatsCards } from "./AgentStatsCards";
import { buildResumeStartPayload } from "../lib/resumeRun";
import { isActiveSwarmPhase, isTerminalSwarmPhase } from "../lib/swarmPhase";
import { resolveBrainAgentId } from "@ollama-swarm/shared/brainAlias";
import { applyStatusSnapshotToStore } from "../state/swarmStoreHydrate";
import { stopControlsDisabled } from "../lib/stopControls";
import { drainIneligibleReason, isDrainEligible } from "@ollama-swarm/shared/drainEligibility";
import { planningSubphaseLabel } from "@ollama-swarm/shared/planningSubphase";
import { apiFetch } from "../lib/apiFetch";


type Tab =
  | "transcript"
  | "metrics"
  | "board"
  | "planning"
  | "contract"
  | "pheromones"
  | "drafts"
  | "verdict"
  | "coverage"
  | "subtasks"
  | "memory"
  | "history"
  | "graph";

export const SwarmView = memo(function SwarmView() {
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);
  const planningSubphase = useSwarm((s) => s.planningSubphase);
  const setError = useSwarm((s) => s.setError);
  const [sayText, setSayText] = useState("");
  // 2026-05-02 (chat lever #2): tagged intent on chat submit. Default
  // "steer" preserves pre-existing send-button behavior. "suggest" =
  // low-pressure consideration; "ask" = inline answer + no direction
  // change. The server's /api/swarm/say schema validates these.
  const [sayIntent, setSayIntent] = useState<"suggest" | "steer" | "ask">("steer");
  /** Run id for an in-flight stop/drain/resume — scoped so concurrent runs stay controllable. */
  const [actionRunId, setActionRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");
  const { runId: routeRunId } = useParams<{ runId?: string }>();

  // React-scan auto in key live-run tabs (transcript, metrics, board) when ?scan=1 or #scan or window enable called.
  // Helps diagnose re-renders during long runs (e.g. blackboard) without manual button every time.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const wantScan = params.get('scan') === '1' || window.location.hash === '#scan' || (window as any).__scanAuto;
    const isLiveTab = tab === 'transcript' || tab === 'metrics' || tab === 'board' || tab === 'planning';
    if (wantScan && isLiveTab && (import.meta as any)?.env?.DEV) {
      (window as any).__scanAuto = true;
      void import('react-scan').then(({ scan }) => {
        scan({ enabled: true });
        console.info('[perf] react-scan auto-enabled for live tab:', tab);
      }).catch(() => {});
    }
  }, [tab]);

  const cfg = useSwarm((s) => s.runConfig);
  // Use hook actions (not .getState()) so they target the per-run scoped store when
  // inside <SwarmStoreProvider> for /runs/:id (prevents writing to singleton while
  // provider hydrates the review store -- major source of missing data / races).
  const setPhaseScoped = useSwarm((s) => s.setPhase);
  const scopedStore = useContext(SwarmStoreContext) ?? swarmSingletonStore;
  // T-Item-MultiTenant Phase 8 (2026-05-04): when the active runId is
  // known, target the per-run REST routes so stop/say affect THIS run
  // even when other runs are concurrently active. Falls back to the
  // legacy aliases (which target most-recent-started) when runId is
  // not yet set — happens during the brief window between
  // /api/swarm/start returning and the first run_started event landing.
  const activeRunId = useSwarm((s) => s.runId);
  const viewRunId = activeRunId ?? routeRunId;
  const stopBusy = actionRunId != null && actionRunId === viewRunId;
  const navigate = useNavigate();

  useEffect(() => {
    setActionRunId(null);
  }, [viewRunId]);
  const stopUrl = activeRunId
    ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/stop`
    : "/api/swarm/stop";
  const sayUrl = activeRunId
    ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/say`
    : "/api/swarm/say";
  const summary = useSwarm((s) => s.summary);
  const transcript = useSwarm((s) => s.transcript);
  const streamingCount = useSwarm((s) => Object.keys(s.streaming).length);
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);

  // Transcript (and everything) shows the full run content.
  const hasTerminalRunFinished = (() => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i];
      const isFin = e.summary?.kind === 'run_finished'
        || (e.text || '').includes('Run finished')
        || (e.text || '').includes('Run failed')
        || (e.text || '').includes('Run stopped');
      if (isFin) {
        const after = transcript.slice(i + 1);
        const hasLaterPhaseStart = after.some(l => /\[Pipeline\].*Starting phase|Starting phase \d+/i.test(l.text || ''));
        return !hasLaterPhaseStart;
      }
    }
    return false;
  })();
  const hasTerminalSummary =
    !!(summary?.stopReason)
    || (isTerminalSwarmPhase(phase) && Array.isArray(summary?.agents) && summary.agents.length > 0);
  const isLiveActivity = streamingCount > 0 || isActiveSwarmPhase(phase);
  const isTerminal = hasTerminalSummary || hasTerminalRunFinished || (isTerminalSwarmPhase(phase) && !isLiveActivity);

  // Always show the agents reported by the active runner (delegated by PipelineRunner for composite presets).
  // Transparent sequencing means the current phase's runner (council or blackboard) provides the agent list.
  // No blanket index-0 filter (prevents incorrect hiding of brain during exec phase or wrong agents during planning).
  const displayAgents = agentList;
  // Capability-driven tabs: only based on preset or actual data presence.
  const hasBoardCapability = !cfg || cfg.preset === "blackboard" || !!(summary as any)?.board || (Array.isArray((summary as any)?.todos) && (summary as any).todos.length > 0);
  const showBlackboardTabs = hasBoardCapability;
  const showMemoryTab = hasBoardCapability;
  // Phase 2 preset-specific primary-signal tabs. Each only appears
  // for its matching preset; tabs from earlier presets in the same
  // session disappear when the user switches.
  const showPheromonesTab = cfg?.preset === "stigmergy";
  const showDraftsTab = cfg?.preset === "council";
  const showVerdictTab = cfg?.preset === "debate-judge";
  const showCoverageTab = cfg?.preset === "map-reduce";
  const showSubtasksTab = cfg?.preset === "orchestrator-worker";
  // If the current tab becomes hidden (user switched presets while on
  // a now-invisible tab), fall back to Transcript so the content area
  // isn't empty.
  useEffect(() => {
    const hiddenTab =
      (!showBlackboardTabs && (tab === "board" || tab === "contract")) ||
      (!showPheromonesTab && tab === "pheromones") ||
      (!showDraftsTab && tab === "drafts") ||
      (!showVerdictTab && tab === "verdict") ||
      (!showCoverageTab && tab === "coverage") ||
      (!showSubtasksTab && tab === "subtasks") ||
      (!showMemoryTab && tab === "memory");
    if (hiddenTab) setTab("transcript");
  }, [
    showBlackboardTabs,
    showPheromonesTab,
    showDraftsTab,
    showVerdictTab,
    showCoverageTab,
    showSubtasksTab,
    showMemoryTab,
    tab,
  ]);

  const applyStatusSnapshot = (snap: any) => {
    if (!snap) return;
    if (typeof window !== "undefined" && window.location.pathname === "/") return;
    const rid = snap.runId ?? activeRunId ?? "unknown";
    applyStatusSnapshotToStore(scopedStore, rid, snap, {
      preferLongerTranscript: true,
    });
  };

  const statusUrl = activeRunId
    ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/status`
    : "/api/swarm/status";

  // Poll while draining/stopping so agent cards + transcript stay in sync
  // when WS events are missed or prompts abort without streaming chunks.
  useEffect(() => {
    if (phase !== "draining" && phase !== "stopping") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiFetch(statusUrl);
        if (!r.ok || cancelled) return;
        const snap = await r.json();
        if (!cancelled) applyStatusSnapshot(snap);
      } catch {
        // retry on next tick
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, statusUrl]);

  const onStop = async () => {
    if (!confirm("Stop the swarm IMMEDIATELY? All spawned opencode processes will be terminated and any worker mid-commit will lose its work.")) return;
    const targetRunId = viewRunId;
    if (!targetRunId) return;
    setActionRunId(targetRunId);
    try {
      const res = await apiFetch(stopUrl, { method: "POST" });
      // Show closing phase immediately; rehydrate will sync summary + terminal state.
      setPhaseScoped("stopping", (useSwarm.getState().round || 0) as any);
      if (!res.ok) {
        // already stopped or not active in backend
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhaseScoped("stopped", (useSwarm.getState().round || 0) as any);
    } finally {
      setActionRunId((cur) => (cur === targetRunId ? null : cur));
      // re-hydrate status so UI reflects backend (especially useful for
      // review/per-run views where phase might be stale)
      apiFetch(statusUrl).then(r => r.ok ? r.json() : null).then(applyStatusSnapshot).catch(() => {});
    }
  };

  // Task #167: soft-stop. Workers finish their current claim (so
  // no in-flight commits get lost), no new claims, then escalates
  // to hard stop. Backstopped at 3 min on the server side.
  const onDrain = async () => {
    if (!confirm("Drain & Stop: workers finish their current claim (no new claims), then the swarm exits. Hung prompts abort after ~90s; full backstop 3 min. OK to proceed?")) return;
    const targetRunId = viewRunId;
    if (!targetRunId) return;
    setPhaseScoped("draining", (useSwarm.getState().round || 0) as any);
    setActionRunId(targetRunId);
    try {
      const drainUrl = viewRunId ? `/api/swarm/drain` : "/api/swarm/drain";
      const body = viewRunId ? JSON.stringify({ runId: viewRunId }) : undefined;
      const res = await apiFetch(drainUrl, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });
      if (!res.ok) {
        const s = useSwarm.getState();
        s.setPhase("stopped", s.round || 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhaseScoped("stopped", (useSwarm.getState().round || 0) as any);
    } finally {
      setActionRunId((cur) => (cur === targetRunId ? null : cur));
      // re-hydrate status so UI reflects backend (especially useful for
      // review/per-run views where phase might be stale)
      apiFetch(statusUrl).then(r => r.ok ? r.json() : null).then(applyStatusSnapshot).catch(() => {});
    }
  };

  const onResume = async () => {
    const payload = buildResumeStartPayload({ runConfig: cfg, summary });
    if (!payload) {
      setError("Cannot resume: missing workspace path or run configuration.");
      return;
    }
    if (!payload.userDirective) {
      const proceed = window.confirm(
        "No user directive found for this run. The swarm will auto-generate goals "
        + "from the codebase instead of following your prior directive. Resume anyway?",
      );
      if (!proceed) return;
    }
    const targetRunId = viewRunId ?? "resume";
    setActionRunId(targetRunId);
    try {
      const res = await apiFetch("/api/swarm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Resume failed (HTTP ${res.status})`);
        return;
      }
      if (body.runId) {
        navigate(`/runs/${encodeURIComponent(body.runId)}`);
      } else {
        setError("Resume failed: server did not return a run id.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionRunId((cur) => (cur === targetRunId ? null : cur));
    }
  };

  // 2026-05-02: parse @mention prefix to honor lever #3's per-agent
  // routing on the server. Pattern: leading "@<token>" where <token>
  // is letters/digits/dashes (matches "agent-2", "planner", "agent-12").
  // Returns the rest of the text (with the @mention stripped) plus
  // the targetAgent id; null target means broadcast.
  const parseMention = (raw: string): { text: string; targetAgent: string | null } => {
    const m = /^\s*@([a-z][a-z0-9-]*)\s+(.+)$/i.exec(raw);
    if (!m) return { text: raw, targetAgent: null };
    return { text: m[2], targetAgent: resolveBrainAgentId(m[1]) };
  };

  const onSay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sayText.trim()) return;
    const { text, targetAgent } = parseMention(sayText);
    try {
      await apiFetch(sayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          intent: sayIntent,
          ...(targetAgent ? { targetAgent } : {}),
        }),
      });
      setSayText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Show stop/drain controls for any run that has not yet reached a terminal phase.
  // isTerminal logic accounts for composite runs with sub phases.
  const canStop = !isTerminal && phase !== "stopping";
  const stopDisabled = stopControlsDisabled(actionRunId, viewRunId, canStop);
  const todos = useSwarm((s) => s.todos);
  const claimedCount = useMemo(
    () => Object.values(todos).filter((t) => t.status === "claimed").length,
    [todos],
  );
  const pendingCommitCount = useMemo(
    () => Object.values(todos).filter((t) => t.status === "pending-commit").length,
    [todos],
  );
  const workerThinking = useMemo(
    () => agentList.some((a) => a.status === "thinking" || a.status === "retrying"),
    [agentList],
  );
  const drainEligible = isDrainEligible({
    phase,
    claimed: claimedCount,
    pendingCommit: pendingCommitCount,
    workerThinking,
  });
  const drainDisabled = stopDisabled || !drainEligible;
  const drainIneligibleTitle = drainEligible
    ? "Soft stop: workers finish their current claim, then swarm exits. Up to 3 min. Preserves in-flight commits."
    : drainIneligibleReason({
        phase,
        claimed: claimedCount,
        pendingCommit: pendingCommitCount,
        workerThinking,
      });

  // Per-preset role labels. Each preset has its own spawn contract:
  //   - blackboard: agent-1=planner, mid=workers, N+1=auditor (Unit 58)
  //   - role-diff: catalog names (Architect/Tester/...) from cfg.roles
  //   - orchestrator-worker: agent-1=orchestrator, mid=workers
  //   - debate-judge: 3 fixed roles — pro / con / judge
  //   - map-reduce: agent-1=reducer, mid=mappers
  //   - council: all drafters (round 1 peer-hidden, round 2+ revisers)
  //   - stigmergy: all explorers (self-organizing, no lead)
  //   - round-robin: all peers (no specialization)
  // Default when cfg is unknown: planner + worker shape (blackboard-ish).
  // Phase 4b of #243: prefer cfg.topology (explicit per-agent specs)
  // when present. Falls back to the legacy preset+index derivation
  // for older clients/runs that didn't ship topology. Role-diff still
  // uses its catalog overlay since topology stores generic "role-diff"
  // labels — the catalog names are richer.
  const agentRole = (idx: number): string => {
    if (cfg?.topology) {
      const spec = cfg.topology.agents.find((a) => a.index === idx);
      if (spec) {
        if (cfg.preset === "role-diff" && cfg.roles && cfg.roles.length > 0) {
          return cfg.roles[(idx - 1) % cfg.roles.length];
        }
        return spec.role;
      }
    }
    if (!cfg) return idx === 1 ? "planner" : "worker";
    // Role-diff overlays catalog names with modulo wrap, matching the
    // server's roleForAgent resolution.
    if (cfg.preset === "role-diff" && cfg.roles && cfg.roles.length > 0) {
      return cfg.roles[(idx - 1) % cfg.roles.length];
    }
    switch (cfg.preset) {
      case "blackboard":
        if (idx === 1) return "planner";
        if (cfg.dedicatedAuditor && idx > cfg.agentCount) return "auditor";
        return "worker";
      case "orchestrator-worker":
        return idx === 1 ? "orchestrator" : "worker";
      case "orchestrator-worker-deep": {
        // Same K calculation as the server (runSummary.roleForAgent +
        // OrchestratorWorkerDeepRunner.computeDeepTopology). Kept in
        // sync so the UI labels match what the runner actually does.
        if (idx === 1) return "orchestrator";
        const remaining = Math.max(0, cfg.agentCount - 1);
        const targetK = Math.max(1, Math.ceil(remaining / 6));
        const maxK = Math.max(1, Math.floor(remaining / 3));
        const k = Math.min(targetK, maxK);
        return idx <= 1 + k ? "mid-lead" : "worker";
      }
      case "map-reduce":
        return idx === 1 ? "reducer" : "mapper";
      case "debate-judge":
        if (idx === 1) return "pro";
        if (idx === 2) return "con";
        if (idx === 3) return "judge";
        return "peer";
      case "council":
        return "drafter";
      case "stigmergy":
        return "explorer";
      case "round-robin":
        return "peer";
      default:
        // Unknown preset — fall back to the blackboard-ish default.
        return idx === 1 ? "planner" : "worker";
    }
  };
  const agentModel = (idx: number): string | undefined => {
    // Phase 4b of #243: per-agent model override from topology row
    // wins over the legacy planner/worker/auditor model fields.
    if (cfg?.topology) {
      const spec = cfg.topology.agents.find((a) => a.index === idx);
      if (spec?.model) return spec.model;
    }
    if (!cfg) return undefined;
    if (idx === 1) return cfg.plannerModel;
    if (cfg.dedicatedAuditor && idx > cfg.agentCount) return cfg.auditorModel;
    return cfg.workerModel;
  };
  // Phase 2 of #243: per-agent color + tag pulled from topology when
  // present. Both undefined → AgentPanel renders without the color
  // border / tag chip (pre-Phase-2 default).
  const agentColor = (idx: number): string | undefined => {
    return cfg?.topology?.agents.find((a) => a.index === idx)?.color;
  };
  const agentTag = (idx: number): string | undefined => {
    return cfg?.topology?.agents.find((a) => a.index === idx)?.tag;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <CloneBanner />
      {phase === "draining" ? (
        <div className="shrink-0 px-3 py-1.5 bg-amber-950/50 border-b border-amber-700/40 text-xs text-amber-200">
          Draining — finishing in-flight work, then stopping. Hung prompts abort after ~90s; use Stop to escalate immediately.
        </div>
      ) : null}
      {(phase === "planning" || phase === "seeding") && planningSubphase ? (
        <div className="shrink-0 px-3 py-1.5 bg-sky-950/40 border-b border-sky-700/30 text-xs text-sky-200">
          Planning — {planningSubphaseLabel(planningSubphase)}. Use Stop to exit immediately (Drain enables once workers are executing or agents are streaming).
        </div>
      ) : null}
      <IdentityStrip />
      <RunOutcomeBanner />
      <div className="flex-1 flex min-h-0">
      <aside className="w-[280px] shrink-0 border-r border-ink-700 p-3 overflow-y-auto space-y-2 bg-ink-800">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">
            Agents ({agentList.length})
          </div>
          {isTerminal ? (
            <button
              onClick={onResume}
              disabled={stopBusy}
              className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Start a new run with the same workspace, preset, models, and agent topology"
            >
              {stopBusy ? "Starting…" : "Run again"}
            </button>
          ) : (
            <div className="flex gap-1">
              {/* Task #167: soft-stop. Blackboard preserves in-flight
                  worker commits; other presets fall through to hard
                  stop on the server side (their parallel-round
                  structure has nothing analogous to drain). */}
              <button
                onClick={onDrain}
                disabled={drainDisabled}
                className="text-xs px-2 py-1 rounded bg-amber-700 hover:bg-amber-600 text-amber-100 font-medium transition-colors disabled:bg-ink-600 disabled:text-ink-300 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-ink-800"
                title={drainIneligibleTitle}
              >
                Drain & Stop
              </button>
              <button
                onClick={onStop}
                disabled={stopDisabled}
                className="text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-red-100 font-medium transition-colors disabled:bg-ink-600 disabled:text-ink-300 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-ink-800"
                title="Hard stop: aborts every in-flight prompt immediately and kills all opencode processes. Worker mid-commit loses its work. Use to escalate during a stuck Drain."
              >
                Stop
              </button>
            </div>
          )}
        </div>
        {/* Live agent cards while the run is active; terminal runs use Final agent stats below. */}
        {!hasTerminalSummary
          ? displayAgents.map((a) => (
              <AgentPanel
                key={a.id}
                agent={a}
                role={agentRole(a.index)}
                model={agentModel(a.index)}
                color={agentColor(a.index)}
                tag={agentTag(a.index)}
              />
            ))
          : null}
        {hasTerminalSummary ? <SidebarSummaryAgents /> : null}
      </aside>
      <section className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex border-b border-ink-700 bg-ink-800 text-sm">
          <TabButton active={tab === "transcript"} onClick={() => setTab("transcript")}>
            Transcript
          </TabButton>
          <TabButton active={tab === "metrics"} onClick={() => setTab("metrics")}>
            Metrics
          </TabButton>
          {/* Board + Contract are blackboard-only surfaces. Hiding
              them on other presets avoids showing misleading empty
              tabs and (pre-fix) a lingering prior-run contract. */}
          {showBlackboardTabs ? (
            <>
          <TabButton active={tab === "board"} onClick={() => setTab("board")}>
            Board
          </TabButton>
          <TabButton active={tab === "planning"} onClick={() => setTab("planning")}>
            Planning
          </TabButton>
              <TabButton active={tab === "contract"} onClick={() => setTab("contract")}>
                Contract
              </TabButton>
            </>
          ) : null}
          {showPheromonesTab ? (
            <TabButton active={tab === "pheromones"} onClick={() => setTab("pheromones")}>
              Pheromones
            </TabButton>
          ) : null}
          {showDraftsTab ? (
            <DraftsTabWithTooltip
              active={tab === "drafts"}
              onClick={() => setTab("drafts")}
              rounds={cfg?.rounds}
              transcript={transcript}
            />
          ) : null}
          {showVerdictTab ? (
            <TabButton active={tab === "verdict"} onClick={() => setTab("verdict")}>
              Verdict
            </TabButton>
          ) : null}
          {showCoverageTab ? (
            <TabButton active={tab === "coverage"} onClick={() => setTab("coverage")}>
              Coverage
            </TabButton>
          ) : null}
          {showSubtasksTab ? (
            <TabButton active={tab === "subtasks"} onClick={() => setTab("subtasks")}>
              Subtasks
            </TabButton>
          ) : null}
          {showMemoryTab ? (
            <TabButton active={tab === "memory"} onClick={() => setTab("memory")}>
              Memory
            </TabButton>
          ) : null}
          <TabButton active={tab === "history"} onClick={() => setTab("history")}>
            History
          </TabButton>
          {cfg?.clonePath ? (
            <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>
              Graph
            </TabButton>
          ) : null}
          <span className="ml-auto self-center px-2"><OutcomeChip /></span>
        </div>
        <div className={`flex-1 min-h-0 ${tab === "transcript" ? "overflow-hidden" : "overflow-y-auto"}`}>
          {tab === "transcript" ? (
            <Transcript />
          ) : tab === "metrics" ? (
            <MetricsPanel />
          ) : tab === "board" && showBlackboardTabs ? (
            <BoardView />
          ) : tab === "contract" && showBlackboardTabs ? (
            <ContractPanel />
          ) : tab === "pheromones" && showPheromonesTab ? (
            <PheromonePanel />
          ) : tab === "drafts" && showDraftsTab ? (
            <DraftMatrix />
          ) : tab === "verdict" && showVerdictTab ? (
            <VerdictPanel />
          ) : tab === "coverage" && showCoverageTab ? (
            <CoveragePanel />
          ) : tab === "subtasks" && showSubtasksTab ? (
            <OwSubtasksPanel />
          ) : tab === "memory" && showMemoryTab ? (
            <div className="h-full overflow-y-auto"><MemoryLogPanel clonePath={cfg?.clonePath} /></div>
          ) : tab === "planning" ? (
            <PlanningTab />
          ) : tab === "history" ? (
            <TranscriptTimeline parentPath={cfg?.clonePath ? `${cfg.clonePath}/logs` : undefined} />
          ) : tab === "graph" && cfg?.clonePath ? (
            <ProjectGraphPanel clonePath={cfg.clonePath} activeRunId={activeRunId ?? undefined} />
          ) : (
            <Transcript />
          )}
        </div>
        <form onSubmit={onSay} className="border-t border-ink-700 p-3 bg-ink-800 flex flex-col gap-2 shrink-0">
          {/* 2026-05-02 (chat lever #2): intent buttons. Defaults to
              steer = current "actively reshape next turn" semantics.
              Suggest = low-pressure consideration; Ask = inline answer
              + no direction change. The server's /say route validates. */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-ink-400 mr-1">Intent:</span>
            {(["suggest", "steer", "ask"] as const).map((it) => (
              <button
                key={it}
                type="button"
                onClick={() => setSayIntent(it)}
                className={`px-2 py-1 rounded ${
                  sayIntent === it
                    ? "bg-emerald-700 text-white"
                    : "bg-ink-700 text-ink-300 hover:bg-ink-600"
                }`}
                title={
                  it === "suggest"
                    ? "Low-pressure suggestion — agents see it but won't change direction unless they choose to."
                    : it === "steer"
                    ? "Steering nudge — planner-tier prompts treat this as an addition to the directive."
                    : "Question — next agent turn answers inline; direction unchanged."
                }
              >
                {it === "suggest" ? "Suggest" : it === "steer" ? "Steer" : "Ask"}
              </button>
            ))}
            <span className="ml-auto text-ink-500">
              Tip: prefix with <code className="bg-ink-900 px-1 rounded">@agent-2</code> to target one agent.
            </span>
          </div>
          <div className="flex gap-2">
            <input
              value={sayText}
              onChange={(e) => setSayText(e.target.value)}
              placeholder={
                sayIntent === "ask"
                  ? "Ask a question (e.g. @agent-1 what's your take on the auth refactor?)"
                  : sayIntent === "suggest"
                  ? "Suggest something to consider (low pressure)…"
                  : "Steer the discussion (active reshape on next turn)…"
              }
              className="flex-1 bg-ink-900 border border-ink-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
            >
              Send
            </button>
          </div>
        </form>
      </section>
      </div>
    </div>
  );
});

// Unit 56: CopyChip moved to its own file (./CopyChip.tsx) so AgentPanel
// can import it too.

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

// Task #84 (2026-04-25): sidebar fallback for completed runs.
// AgentManager.killAll() clears the live agents map at run-end so
// the AgentPanel cards disappear. Without this fallback the sidebar
// shows "No agents yet" even on a healthy completed run, which is
// jarring next to all the rich main-viewport content. Renders a
// compact card per summary.agents entry.
function SidebarSummaryAgents() {
  const summary = useSwarm((s) => s.summary);
  const cfg = useSwarm((s) => s.runConfig);
  if (!summary || summary.agents.length === 0) {
    return <div className="text-xs text-ink-400">No agents yet.</div>;
  }
  const preset = cfg?.preset ?? summary.preset;
  return <AgentStatsCards agents={summary.agents} preset={preset} />;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={
        "px-4 py-2 border-b-2 transition-colors " +
        (active
          ? "border-emerald-500 text-emerald-300"
          : "border-transparent text-ink-400 hover:text-ink-200")
      }
    >
      {children}
    </button>
  );
}
