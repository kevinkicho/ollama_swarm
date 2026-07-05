import { memo, useEffect, useState, Fragment } from "react";
import { useSwarm } from "../state/store";
import { AgentPanel } from "./AgentPanel";
import { useNavigate } from "react-router-dom";
import { BoardView } from "./BoardView";
import { ContractPanel } from "./ContractPanel";
import { Transcript } from "./Transcript";
import { MetricsPanel } from "./MetricsPanel";
import { PheromonePanel } from "./PheromonePanel";
import { DraftMatrix } from "./DraftMatrix";
import { VerdictPanel } from "./VerdictPanel";
import { CoveragePanel } from "./CoveragePanel";
import { OwSubtasksPanel } from "./OwSubtasksPanel";
import { MemoryLogPanel } from "./MemoryLogPanel";
import { CloneBanner } from "./CloneBanner";
import { IdentityStrip } from "./IdentityStrip";
import { ProgressBar } from "./ProgressBar";
import { TranscriptTimeline } from "./TranscriptTimeline";
import { PlanningTab } from "./PlanningTab";
import { OutcomeChip } from "./OutcomeChip";
import { fmtMs, roleForRow } from "./RunHistory";


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
  | "history";

export const SwarmView = memo(function SwarmView() {
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);
  const setError = useSwarm((s) => s.setError);
  const [sayText, setSayText] = useState("");
  // 2026-05-02 (chat lever #2): tagged intent on chat submit. Default
  // "steer" preserves pre-existing send-button behavior. "suggest" =
  // low-pressure consideration; "ask" = inline answer + no direction
  // change. The server's /api/swarm/say schema validates these.
  const [sayIntent, setSayIntent] = useState<"suggest" | "steer" | "ask">("steer");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");

  // React-scan auto in key live-run tabs (transcript, metrics, board) when ?scan=1 or #scan or window enable called.
  // Helps diagnose re-renders during hybrid/blackboard runs without manual button every time.
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

  const reset = useSwarm((s) => s.reset);
  const cfg = useSwarm((s) => s.runConfig);
  // Use hook actions (not .getState()) so they target the per-run scoped store when
  // inside <SwarmStoreProvider> for /runs/:id (prevents writing to singleton while
  // provider hydrates the review store -- major source of missing data / races).
  const setPhaseScoped = useSwarm((s) => s.setPhase);
  const upsertAgentScoped = useSwarm((s) => s.upsertAgent);
  const setSummaryScoped = useSwarm((s) => s.setSummary);
  const appendEntryScoped = useSwarm((s) => s.appendEntry);
  // T-Item-MultiTenant Phase 8 (2026-05-04): when the active runId is
  // known, target the per-run REST routes so stop/say affect THIS run
  // even when other runs are concurrently active. Falls back to the
  // legacy aliases (which target most-recent-started) when runId is
  // not yet set — happens during the brief window between
  // /api/swarm/start returning and the first run_started event landing.
  const activeRunId = useSwarm((s) => s.runId);
  const navigate = useNavigate();
  const stopUrl = activeRunId
    ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/stop`
    : "/api/swarm/stop";
  const sayUrl = activeRunId
    ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/say`
    : "/api/swarm/say";
  const summary = useSwarm((s) => s.summary);
  const transcript = useSwarm((s) => s.transcript);
  const cfgForHybrid = useSwarm((s) => s.runConfig);
  // Robust hybrid detection: prefer explicit flags from runConfig.
  // Also fall back to pipeline marker in live transcript or summary (for runs where hydrate only partially restored flags).
  const allTx = [...(transcript || []), ...((summary as any)?.transcript || [])];
  const transcriptHasHybridMarker = allTx.some((e: any) => {
    const t = String(e?.text || e || "");
    return /council\s*→\s*blackboard/i.test(t) || (/council/i.test(t) && /blackboard/i.test(t) && /phase/i.test(t));
  });
  const isHybrid = !!(cfgForHybrid?.useHybridPlanning || cfgForHybrid?.planningPreset || (cfgForHybrid as any)?.pipeline || transcriptHasHybridMarker);
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);
  // For hybrid (council as planner group + blackboard execution): 
  // - hide brain, bogus index 0, and blackboard's index-1 "planner" (replaced by council group)
  // - this makes the "other" agents the correct execution ones (3 workers + 1 auditor etc, based on user-provided agentCount at start)
  const displayAgents = isHybrid 
    ? agentList.filter(a => !(a.id === 'brain' || (a.index || 0) === 0 || (a.index || 0) === 1))
    : agentList;
  const showAsPlannerGroup = isHybrid; // always highlight/box for hybrid to show the council-as-planner group + execution agents
  const hasTerminalSummary = !!summary && (!!summary.stopReason || typeof summary.endedAt === 'number');
  // For hybrid/pipeline runs, rely primarily on phase; hasTerminalSummary can be set
  // by sub-phase summaries and would incorrectly hide stop/drain buttons during active execution.
  const hasExecution = isHybrid && allTx.some((e: any) => /blackboard.*phase|phase.*blackboard/i.test(String(e.text || '')));
  // Bug1 fix: stronger guard. For hybrid, do not treat as terminal (hiding Stop/Drain buttons) just because
  // a sub-phase summary exists or phase lags. Only hide controls for explicit terminal phases once execution started or not hybrid.
  const isExplicitTerminalPhase = phase === "completed" || phase === "stopped" || phase === "failed";
  const isTerminal = isExplicitTerminalPhase && !(isHybrid && (phase === 'discussing' || !hasExecution));
  // Board + Contract are blackboard-specific surfaces. Show the tabs
  // only for blackboard runs (including pre-start when the preset is
  // selected but no run config exists yet — default to showing them
  // since the SetupForm is open).
  const showBlackboardTabs = !cfg || cfg.preset === "blackboard";
  // Task #152: memory-log tab. .swarm-memory.jsonl is blackboard-only
  // today (only blackboard runs write entries via #130); show the tab
  // for blackboard runs and pre-start (when SetupForm is open).
  const showMemoryTab = !cfg || cfg.preset === "blackboard";
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

  const onStop = async () => {
    if (!confirm("Stop the swarm IMMEDIATELY? All spawned opencode processes will be terminated and any worker mid-commit will lose its work.")) return;
    setBusy(true);
    try {
      const res = await fetch(stopUrl, { method: "POST" });
      // Always force terminal in UI for immediate feedback (stop may be async on backend, rehydrate will sync summary etc.)
      setPhaseScoped("stopped", (useSwarm.getState().round || 0) as any);
      if (!res.ok) {
        // already stopped or not active in backend
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhaseScoped("stopped", (useSwarm.getState().round || 0) as any);
    } finally {
      setBusy(false);
      // re-hydrate status so UI reflects backend (especially useful for
      // review/per-run views where phase might be stale)
      const statusUrl = activeRunId
        ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/status`
        : "/api/swarm/status";
      fetch(statusUrl).then(r => r.ok ? r.json() : null).then(snap => {
        if (snap) {
          // Extra root guard – do not let stop/drain rehydrate paths pollute the
          // singleton when we're on the setup root (prevents the recurring flash).
          if (typeof window !== 'undefined' && window.location.pathname === '/') return;

          setPhaseScoped(snap.phase || "stopped", snap.round || 0);
          const hasCompletedSummary = !!(snap.summary && (snap.summary.stopReason || snap.summary.endedAt != null));
          if (snap.agents && !hasCompletedSummary) {
            snap.agents.forEach((a: any) => {
              const idx = a.index ?? a.agentIndex ?? 0;
              const id = a.id || a.agentId || `agent-${idx}`;
              upsertAgentScoped({ id, index: idx, status: a.status || "stopped", model: a.model } as any);
            });
          }
          if (snap.summary) setSummaryScoped(snap.summary);
          if (snap.transcript && Array.isArray(snap.transcript)) {
            snap.transcript.forEach((e: any) => appendEntryScoped(e));
          }
        }
      }).catch(() => {});
    }
  };

  // Task #167: soft-stop. Workers finish their current claim (so
  // no in-flight commits get lost), no new claims, then escalates
  // to hard stop. Backstopped at 3 min on the server side.
  const onDrain = async () => {
    if (!confirm("Drain & Stop: workers will finish their current claim (no new claims), then the swarm exits. Up to 3 minutes. OK to proceed?")) return;
    setBusy(true);
    try {
      const drainUrl = activeRunId
        ? `/api/swarm/drain`
        : "/api/swarm/drain";
      const body = activeRunId ? JSON.stringify({ runId: activeRunId }) : undefined;
      const res = await fetch(drainUrl, {
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
      setBusy(false);
      // re-hydrate status so UI reflects backend (especially useful for
      // review/per-run views where phase might be stale)
      const statusUrl = activeRunId
        ? `/api/swarm/runs/${encodeURIComponent(activeRunId)}/status`
        : "/api/swarm/status";
      fetch(statusUrl).then(r => r.ok ? r.json() : null).then(snap => {
        if (snap) {
          // Extra root guard – do not let stop/drain rehydrate paths pollute the
          // singleton when we're on the setup root (prevents the recurring flash).
          if (typeof window !== 'undefined' && window.location.pathname === '/') return;

          setPhaseScoped(snap.phase || "stopped", snap.round || 0);
          const hasCompletedSummary = !!(snap.summary && (snap.summary.stopReason || snap.summary.endedAt != null));
          if (snap.agents && !hasCompletedSummary) {
            snap.agents.forEach((a: any) => {
              const idx = a.index ?? a.agentIndex ?? 0;
              const id = a.id || a.agentId || `agent-${idx}`;
              upsertAgentScoped({ id, index: idx, status: a.status || "stopped", model: a.model } as any);
            });
          }
          if (snap.summary) setSummaryScoped(snap.summary);
          if (snap.transcript && Array.isArray(snap.transcript)) {
            snap.transcript.forEach((e: any) => appendEntryScoped(e));
          }
        }
      }).catch(() => {});
    }
  };

  const onNewSwarm = () => {
    reset();
    navigate("/");
  };

  // 2026-05-02: parse @mention prefix to honor lever #3's per-agent
  // routing on the server. Pattern: leading "@<token>" where <token>
  // is letters/digits/dashes (matches "agent-2", "planner", "agent-12").
  // Returns the rest of the text (with the @mention stripped) plus
  // the targetAgent id; null target means broadcast.
  const parseMention = (raw: string): { text: string; targetAgent: string | null } => {
    const m = /^\s*@([a-z][a-z0-9-]*)\s+(.+)$/i.exec(raw);
    if (!m) return { text: raw, targetAgent: null };
    return { text: m[2], targetAgent: m[1] };
  };

  const onSay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sayText.trim()) return;
    const { text, targetAgent } = parseMention(sayText);
    try {
      await fetch(sayUrl, {
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

  // Simpler + more robust for hybrid: show stop/drain controls for any run that has not yet reached a terminal phase.
  // This prevents "buttons disappeared" when sub-summaries or phase lag make isTerminal true too early.
  const canStop = phase !== "stopping" && phase !== "stopped" && phase !== "failed" && phase !== "completed";

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
      <IdentityStrip />
      <div className="flex-1 flex min-h-0">
      <aside className="w-[280px] shrink-0 border-r border-ink-700 p-3 overflow-y-auto space-y-2 bg-ink-800">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">
            {showAsPlannerGroup ? 'Planners (council group)' : 'Agents'} <span className="text-ink-500 font-mono normal-case">({agentList.length})</span>
          </div>
          {isTerminal ? (
            <button
              onClick={onNewSwarm}
              className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
              title="Reset the UI to the setup form. Doesn't affect the just-finished run's saved summary."
            >
              New swarm
            </button>
          ) : (
            <div className="flex gap-1">
              {/* Task #167: soft-stop. Blackboard preserves in-flight
                  worker commits; other presets fall through to hard
                  stop on the server side (their parallel-round
                  structure has nothing analogous to drain). */}
              <button
                onClick={onDrain}
                disabled={busy || !canStop}
                className="text-xs px-2 py-1 rounded bg-amber-700 hover:bg-amber-600 disabled:bg-ink-600 disabled:cursor-not-allowed"
                title="Soft stop: workers finish their current claim, then swarm exits. Up to 3 min. Preserves in-flight commits. (Discussion presets: same as Stop — no in-flight work to preserve.)"
              >
                Drain & Stop
              </button>
              <button
                onClick={onStop}
                disabled={busy || !canStop}
                className="text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 disabled:bg-ink-600 disabled:cursor-not-allowed"
                title="Hard stop: aborts every in-flight prompt immediately and kills all opencode processes. Worker mid-commit loses its work. Use to escalate during a stuck Drain."
              >
                Stop
              </button>
            </div>
          )}
        </div>
        {isHybrid && (
          <>
            {/* Always show the council as planner boxed for hybrid (replaces blackboard planner).
                Number (typically 3 for council) made dependent on user-provided agentCount param at swarm start (min 3, or from config).
                Always use synthetic here (real planning agents may not persist into exec phase; avoid picking blackboard's index-1 as "planner").
                This ensures correct 3 boxed 'planner' + the execution agents (workers+auditor) shown in displayAgents. */}
            <div className="border border-violet-600/60 rounded p-1 mb-2 bg-ink-900/30">
              <div className="text-[9px] uppercase tracking-wider text-violet-300 mb-1 px-1">planner (council 3 agents collectively)</div>
              {(() => {
                const plannerCount = Math.max(3, Math.min(3, (cfgForHybrid?.agentCount || 3)));
                return Array.from({length: plannerCount}, (_, k) => k + 1).map(idx => (
                  <AgentPanel
                    key={`planner-${idx}`}
                    agent={{ id: `planner-${idx}`, index: idx, status: 'ready', model: 'council' } as any}
                    role="planner"
                  />
                ));
              })()}
            </div>
          </>
        )}
        {/* Execution agents from blackboard phase */}
        {displayAgents.map((a) => (
          <AgentPanel
            key={a.id}
            agent={a}
            role={agentRole(a.index)}
            model={agentModel(a.index)}
            color={agentColor(a.index)}
            tag={agentTag(a.index)}
          />
        ))}
        {/* If hybrid and no live execution agents yet (e.g. still in planning phase or early), show synthetic execution agents based on the user-provided agentCount at start.
            This ensures the sidebar always shows the full team: 3 (or N) planners boxed + the expected workers + auditor.
            When execution agents populate via WS/status, displayAgents will show the real ones instead. */}
        {isHybrid && displayAgents.length === 0 && (() => {
          // Show synthetic execution agents when live ones not yet populated (e.g. still in planning phase).
          // Number based on user-provided agentCount at start + dedicatedAuditor.
          // E.g. agentCount=4 + dedicated => execCount ~4 (3 workers +1 auditor)
          const baseCount = cfgForHybrid?.agentCount || 4;
          const dedicated = !!cfgForHybrid?.dedicatedAuditor;
          const execCount = baseCount + (dedicated ? 1 : 0) - 1; // total for bb exec minus the replaced planner slot; e.g. 4+1-1=4 for 3w+1a
          return Array.from({length: execCount}, (_, k) => {
            const idx = 4 + k;
            const isAuditor = dedicated && k === execCount - 1;
            return (
              <div key={`exec-${idx}`} className="rounded border border-ink-700 bg-ink-800/50 p-2 text-xs mb-1">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-ink-100 font-semibold">agent-{idx}</span>
                  <span className="text-[10px] text-ink-400 font-mono">{isAuditor ? 'auditor' : 'worker'}</span>
                </div>
                <div className="text-ink-400">blackboard execution (pending)</div>
              </div>
            );
          });
        })()}
        {/* For finished runs (length==0 after kill), show summary for stats.
            For hybrid, also show summary on terminal so execution agents' details (runs/fails, commits, lines etc) are shown, even if live length==0.
            This prevents "No agents yet." inappropriately during hybrid runtime or finished without live list. */}
        {(() => {
          const showSummary = agentList.length === 0 && !(isHybrid && !hasTerminalSummary && displayAgents.length === 0);
          return showSummary ? <SidebarSummaryAgents /> : null;
        })()}
        {/* Note: removed duplicate synthetic block for finished hybrid (length==0 case).
            The main isHybrid boxed above already covers synthetic 3 council planners for finished runs.
            When finished, SidebarSummaryAgents (below) will show the execution agents' detailed stats (runs/fails, commits, lines +/- etc).
            This prevents duplicate/wrong agents like extra 3 planners + only 3 finished instead of 4. */}
      </aside>
      <section className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ProgressBar />
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
            <TabButton active={tab === "drafts"} onClick={() => setTab("drafts")}>
              Drafts
            </TabButton>
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
  return (
    <>
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mt-2 mb-1">
        Final agent stats
      </div>
      {summary.agents.map((a, idx) => {
        const role = cfg ? roleForRow(cfg.preset, a.agentIndex, summary.agents.length) : "agent";
        const lines = (a.linesAdded ?? 0) + (a.linesRemoved ?? 0);
        return (
          <div key={a.agentId || `agent-${a.agentIndex || idx}`} className="rounded border border-ink-700 bg-ink-800/50 p-2 text-xs">
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className="text-ink-100 font-semibold">agent-{a.agentIndex}</span>
              <span className="text-[10px] text-ink-400 font-mono">{role}</span>
            </div>
            <div className="text-[10px] font-mono text-ink-300 grid grid-cols-2 gap-x-2 gap-y-0.5">
              <span className="text-ink-500">turns</span><span className="text-right">{a.turnsTaken}</span>
              {a.totalAttempts !== undefined ? <Fragment key="attempts"><span className="text-ink-500">attempts</span><span className="text-right">{a.totalAttempts}</span></Fragment> : null}
              {a.totalRetries !== undefined && a.totalRetries > 0 ? <Fragment key="retries"><span className="text-ink-500">retries</span><span className="text-right text-amber-300">{a.totalRetries}</span></Fragment> : null}
              {a.meanLatencyMs ? <Fragment key="mean"><span className="text-ink-500">mean</span><span className="text-right">{fmtMs(a.meanLatencyMs)}</span></Fragment> : null}
              {a.commits !== undefined && a.commits > 0 ? <Fragment key="commits"><span className="text-ink-500">commits</span><span className="text-right text-emerald-300">{a.commits}</span></Fragment> : null}
              {lines > 0 ? <Fragment key="lines"><span className="text-ink-500">lines</span><span className="text-right"><span className="text-emerald-300">+{a.linesAdded ?? 0}</span> <span className="text-rose-300">−{a.linesRemoved ?? 0}</span></span></Fragment> : null}
              {a.rejectedAttempts !== undefined && a.rejectedAttempts > 0 ? <Fragment key="rejected"><span className="text-ink-500">rejected</span><span className="text-right text-rose-300">{a.rejectedAttempts}</span></Fragment> : null}
            </div>
          </div>
        );
      })}
    </>
  );
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
