import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";
import { AgentPanel } from "./AgentPanel";
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
import { fmtMs, roleForRow } from "./RunHistory";

type Tab =
  | "transcript"
  | "metrics"
  | "board"
  | "contract"
  | "pheromones"
  | "drafts"
  | "verdict"
  | "coverage"
  | "subtasks"
  | "memory";

export function SwarmView() {
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);
  const setError = useSwarm((s) => s.setError);
  const [sayText, setSayText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");

  const reset = useSwarm((s) => s.reset);
  const cfg = useSwarm((s) => s.runConfig);
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);
  const isTerminal = phase === "completed" || phase === "stopped" || phase === "failed";
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
      await fetch("/api/swarm/stop", { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Task #167: soft-stop. Workers finish their current claim (so
  // no in-flight commits get lost), no new claims, then escalates
  // to hard stop. Backstopped at 3 min on the server side.
  const onDrain = async () => {
    if (!confirm("Drain & Stop: workers will finish their current claim (no new claims), then the swarm exits. Up to 3 minutes. OK to proceed?")) return;
    setBusy(true);
    try {
      await fetch("/api/swarm/drain", { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onNewSwarm = () => {
    reset();
  };

  const onSay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sayText.trim()) return;
    try {
      await fetch("/api/swarm/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sayText }),
      });
      setSayText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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
    <div className="h-full flex flex-col">
      <CloneBanner />
      <IdentityStrip />
      <div className="flex-1 grid grid-cols-[280px_1fr] min-h-0">
      <aside className="border-r border-ink-700 p-3 overflow-y-auto space-y-2 bg-ink-800">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">
            Agents <span className="text-ink-500 font-mono normal-case">({agentList.length})</span>
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
        {agentList.map((a) => (
          <AgentPanel
            key={a.id}
            agent={a}
            role={agentRole(a.index)}
            model={agentModel(a.index)}
            color={agentColor(a.index)}
            tag={agentTag(a.index)}
          />
        ))}
        {/* 2026-04-25: when the live agents map is empty (run completed
            and killAll cleared the roster), fall back to a compact
            list sourced from summary.agents so the sidebar isn't
            misleadingly empty after a finished run. */}
        {agentList.length === 0 ? <SidebarSummaryAgents /> : null}
      </aside>
      <section className="flex flex-col overflow-hidden">
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
        </div>
        <div className="flex-1 overflow-hidden">
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
          ) : (
            <Transcript />
          )}
        </div>
        <form onSubmit={onSay} className="border-t border-ink-700 p-3 bg-ink-800 flex gap-2">
          <input
            value={sayText}
            onChange={(e) => setSayText(e.target.value)}
            placeholder="Inject a message into the discussion (as orchestrator)…"
            className="flex-1 bg-ink-900 border border-ink-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
          >
            Send
          </button>
        </form>
      </section>
      </div>
    </div>
  );
}

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
      {summary.agents.map((a) => {
        const role = cfg ? roleForRow(cfg.preset, a.agentIndex, summary.agents.length) : "agent";
        const lines = (a.linesAdded ?? 0) + (a.linesRemoved ?? 0);
        return (
          <div key={a.agentId} className="rounded border border-ink-700 bg-ink-800/50 p-2 text-xs">
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className="text-ink-100 font-semibold">agent-{a.agentIndex}</span>
              <span className="text-[10px] text-ink-400 font-mono">{role}</span>
            </div>
            <div className="text-[10px] font-mono text-ink-300 grid grid-cols-2 gap-x-2 gap-y-0.5">
              <span className="text-ink-500">turns</span><span className="text-right">{a.turnsTaken}</span>
              {a.totalAttempts !== undefined ? <><span className="text-ink-500">attempts</span><span className="text-right">{a.totalAttempts}</span></> : null}
              {a.totalRetries !== undefined && a.totalRetries > 0 ? <><span className="text-ink-500">retries</span><span className="text-right text-amber-300">{a.totalRetries}</span></> : null}
              {a.meanLatencyMs ? <><span className="text-ink-500">mean</span><span className="text-right">{fmtMs(a.meanLatencyMs)}</span></> : null}
              {a.commits !== undefined && a.commits > 0 ? <><span className="text-ink-500">commits</span><span className="text-right text-emerald-300">{a.commits}</span></> : null}
              {lines > 0 ? <><span className="text-ink-500">lines</span><span className="text-right"><span className="text-emerald-300">+{a.linesAdded ?? 0}</span> <span className="text-rose-300">−{a.linesRemoved ?? 0}</span></span></> : null}
              {a.rejectedAttempts !== undefined && a.rejectedAttempts > 0 ? <><span className="text-ink-500">rejected</span><span className="text-right text-rose-300">{a.rejectedAttempts}</span></> : null}
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
