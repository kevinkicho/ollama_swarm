import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";
import type { PerAgentStat, RunSummary, RunSummaryDigest } from "../types";
import { AgentPanel } from "./AgentPanel";
import { BoardView } from "./BoardView";
import { ContractPanel } from "./ContractPanel";
import { CopyChip } from "./CopyChip";
import { Transcript } from "./Transcript";
import { MetricsPanel } from "./MetricsPanel";
import { PheromonePanel } from "./PheromonePanel";
import { DraftMatrix } from "./DraftMatrix";
import { VerdictPanel } from "./VerdictPanel";
import { CoveragePanel } from "./CoveragePanel";
import { OwSubtasksPanel } from "./OwSubtasksPanel";

type Tab =
  | "transcript"
  | "metrics"
  | "board"
  | "contract"
  | "pheromones"
  | "drafts"
  | "verdict"
  | "coverage"
  | "subtasks";

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
      (!showSubtasksTab && tab === "subtasks");
    if (hiddenTab) setTab("transcript");
  }, [
    showBlackboardTabs,
    showPheromonesTab,
    showDraftsTab,
    showVerdictTab,
    showCoverageTab,
    showSubtasksTab,
    tab,
  ]);

  const onStop = async () => {
    if (!confirm("Stop the swarm? All spawned opencode processes will be terminated.")) return;
    setBusy(true);
    try {
      await fetch("/api/swarm/stop", { method: "POST" });
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
  const agentRole = (idx: number): string => {
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
    if (!cfg) return undefined;
    if (idx === 1) return cfg.plannerModel;
    if (cfg.dedicatedAuditor && idx > cfg.agentCount) return cfg.auditorModel;
    return cfg.workerModel;
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
            >
              New swarm
            </button>
          ) : (
            <button
              onClick={onStop}
              disabled={busy || !canStop}
              className="text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 disabled:bg-ink-600 disabled:cursor-not-allowed"
            >
              Stop
            </button>
          )}
        </div>
        {agentList.map((a) => (
          <AgentPanel key={a.id} agent={a} role={agentRole(a.index)} model={agentModel(a.index)} />
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

// Unit 47: dismissible banner shown when the runner reuses an
// existing clone (build-on-existing-clone work pattern). Hides
// silently for fresh clones since "you started a fresh clone" isn't
// information the user needs to see — that's the default expectation.
function CloneBanner() {
  const cloneState = useSwarm((s) => s.cloneState);
  const dismissed = useSwarm((s) => s.cloneBannerDismissed);
  const dismiss = useSwarm((s) => s.dismissCloneBanner);
  if (!cloneState || !cloneState.alreadyPresent || dismissed) return null;
  const { priorCommits, priorChangedFiles, priorUntrackedFiles, clonePath } = cloneState;
  const parts: string[] = [];
  if (priorCommits > 0) parts.push(`${priorCommits} prior commit${priorCommits === 1 ? "" : "s"}`);
  if (priorChangedFiles > 0) parts.push(`${priorChangedFiles} modified file${priorChangedFiles === 1 ? "" : "s"}`);
  if (priorUntrackedFiles > 0) parts.push(`${priorUntrackedFiles} untracked file${priorUntrackedFiles === 1 ? "" : "s"}`);
  const detail = parts.length > 0 ? parts.join(" · ") : "no working-tree changes";
  return (
    <div className="bg-blue-900/40 border-b border-blue-700/50 text-blue-100 text-sm px-4 py-2 flex items-center gap-3">
      <span className="text-blue-300 font-semibold">Resume:</span>
      <span className="flex-1">
        Building on an existing clone — {detail}.
        <span className="text-blue-300/70 font-mono ml-2 text-xs" title={clonePath}>
          {truncateLeft(clonePath, 60)}
        </span>
      </span>
      <button
        onClick={dismiss}
        className="text-blue-300 hover:text-blue-100 text-xs px-2 py-0.5 border border-blue-700/50 rounded hover:bg-blue-800/40"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// Truncate-from-LEFT (per Kevin's Unit 52c spec preference): the
// distinguishing tail of a path is the run-name + repo-name, not the
// shared `/mnt/c/Users/...` prefix.
function truncateLeft(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return "…" + s.slice(s.length - maxLen + 1);
}

// Unit 52c (Unit 56-consolidated): single run-identity topbar showing
// run uuid + run name + preset + planner/worker models + agent count
// + clone path. The path is click-to-open via POST /api/swarm/open
// (server validates the request matches the active run's clonePath,
// then shells out to Explorer/Finder/xdg-open). Per-agent session ids
// + models live in the AgentPanel cards (Unit 56) — this strip only
// carries run-level metadata.
function IdentityStrip() {
  const cfg = useSwarm((s) => s.runConfig);
  const runId = useSwarm((s) => s.runId);
  // Task #85: history dropdown moved to the App-level header so it's
  // also reachable from the SetupForm. IdentityStrip no longer
  // renders it — keep `history = null` so existing layout doesn't
  // shift when this strip appears.
  const history = null;
  if (!cfg && !runId) return null;
  const runName = cfg ? deriveRunName(cfg.clonePath) : "(unnamed run)";
  const onOpen = async () => {
    if (!cfg) return;
    // Task #45: retry on TypeError: Failed to fetch (tsx-watch restart
    // window makes the backend briefly unreachable — 2-5s typical).
    // Retry 3 times with 500ms backoff before giving up.
    const attemptOnce = async (): Promise<{ ok: boolean; err?: unknown }> => {
      try {
        const res = await fetch("/api/swarm/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: cfg.clonePath }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, err: body.error ?? `HTTP ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    };
    for (let i = 0; i < 3; i++) {
      const result = await attemptOnce();
      if (result.ok) return;
      // Only retry on TypeError (network-level). HTTP errors are permanent.
      if (!(result.err instanceof TypeError)) {
        console.warn("open clone path failed:", result.err);
        return;
      }
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.warn("open clone path failed after 3 retries:", result.err);
      }
    }
  };
  const sameModel = cfg && cfg.plannerModel === cfg.workerModel;
  return (
    <div className="bg-ink-900/60 border-b border-ink-700 px-4 py-1.5 flex items-center gap-2.5 text-xs font-mono text-ink-300 flex-wrap">
      {runId ? (
        <CopyChip label="run" value={runId} short={runId.slice(0, 8)} />
      ) : null}
      {/* Task #35: preset badge immediately after the runId chip — they're
          the two most-scanned anchors in the strip, and pairing them lets
          users instantly see "this is the {preset} run with id {short}".
          Uppercase pill style is intentional: visually distinct from the
          monospace runId and the model chips. */}
      {cfg ? (
        <PresetBadge preset={cfg.preset} />
      ) : null}
      {cfg ? (
        <>
          <span className="text-ink-600">·</span>
          <span className="text-ink-100 font-semibold">{runName}</span>
          <span className="text-ink-600">·</span>
          {sameModel ? (
            <span title="Planner + worker model"><span className="text-ink-500">model</span> {cfg.plannerModel}</span>
          ) : (
            <>
              <span title="Planner model"><span className="text-ink-500">planner</span> {cfg.plannerModel}</span>
              <span className="text-ink-600">·</span>
              <span title="Worker model"><span className="text-ink-500">worker</span> {cfg.workerModel}</span>
            </>
          )}
          {/* Topbar dedup: dropped the "agents N" segment. cfg.agentCount
              excludes the dedicated auditor (Unit 58) so the count was
              wrong for 4-agent runs, and the live agent count is already
              in the left sidebar header. Dedup over fix-the-count. */}
          <button
            onClick={onOpen}
            title={`Open in OS file manager — ${cfg.clonePath}`}
            className="text-ink-400 hover:text-ink-100 hover:underline truncate max-w-md inline-block align-bottom ml-auto"
          >
            {truncateLeft(cfg.clonePath, 60)}
          </button>
        </>
      ) : null}
      {history}
    </div>
  );
}

// Task #35: pill-style badge for the active preset, rendered right
// after the runId chip in IdentityStrip. Per-preset color so a quick
// glance distinguishes a write-capable blackboard run from a read-
// only discussion preset. Uppercase + tracking for visual weight
// against the surrounding monospace chips.
function PresetBadge({ preset }: { preset: string }) {
  // Color buckets: write-capable = emerald (signals "this run will
  // change files"); read-only discussion presets = ink-blue tones.
  // Debate-judge (PRO/CON dynamic) gets amber. Stigmergy (self-
  // organizing) gets teal. Council/role-diff/orchestrator-worker/
  // map-reduce/round-robin share a neutral indigo.
  const palette = ((): { bg: string; fg: string; border: string } => {
    switch (preset) {
      case "blackboard":
        return { bg: "bg-emerald-900/40", fg: "text-emerald-200", border: "border-emerald-700" };
      case "debate-judge":
        return { bg: "bg-amber-900/30", fg: "text-amber-200", border: "border-amber-700" };
      case "stigmergy":
        return { bg: "bg-teal-900/30", fg: "text-teal-200", border: "border-teal-700" };
      default:
        return { bg: "bg-indigo-900/30", fg: "text-indigo-200", border: "border-indigo-700" };
    }
  })();
  return (
    <span
      title={`Preset: ${preset}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider font-semibold ${palette.bg} ${palette.fg} ${palette.border}`}
    >
      {preset}
    </span>
  );
}

// Run name = basename of the clone path. Falls back to a placeholder
// if the path lacks a meaningful tail (defensive).
function deriveRunName(clonePath: string): string {
  // Cross-platform basename: split on either separator and grab the
  // non-empty tail. Path module on web is overkill for this.
  const parts = clonePath.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "(unnamed run)";
}

// Unit 56: IdentifiersRow has been deleted as a separate row.
// - run uuid moved into IdentityStrip's leading chip
// - per-agent session id + model moved into AgentPanel cards
// - history dropdown moved into IdentityStrip's right edge
// Net result: 2 topbars collapsed to 1; agent-scoped info renders
// where you already look for the agent (the sidebar card).

// Unit 52e: lazy-fetches GET /api/runs when opened, lists prior runs
// in the active run's parent dir, click row → modal with the prior
// summary's headline data + Open Folder button (POST /open). Stays
// closed until the user clicks — no eager fetching that would race
// page-load.
// Task #85 (2026-04-25): exported so the App-level top header can
// render the dropdown even before any run has started — users can
// review past runs from the SetupForm flash page without first
// having to start a new run.
export function RunHistoryDropdown() {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummaryDigest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RunSummaryDigest | null>(null);

  // Refetch on open so the list reflects any sibling runs that
  // appeared since the previous open. Cheap — directory listing.
  // Task #47: retry on TypeError: Failed to fetch so tsx-watch restart
  // windows don't surface as a permanent error in the dropdown.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch("/api/swarm/runs");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.json();
          if (cancelled) return;
          const list = Array.isArray(body.runs) ? (body.runs as RunSummaryDigest[]) : [];
          setRuns(list);
          setLoading(false);
          return;
        } catch (err) {
          const isNetwork = err instanceof TypeError;
          if (!isNetwork || attempt === 2) {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : String(err));
              setLoading(false);
            }
            return;
          }
          await new Promise((r2) => setTimeout(r2, 500));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onOpenFolder = async (clonePath: string) => {
    try {
      const res = await fetch("/api/swarm/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: clonePath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.warn("open prior run path failed:", body.error ?? res.status);
      }
    } catch (err) {
      console.warn("open prior run path failed:", err);
    }
  };

  return (
    <span className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Show prior runs in this parent folder"
        className="text-ink-400 hover:text-ink-100 hover:bg-ink-800/70 rounded px-2 py-0.5 border border-ink-700 hover:border-ink-600 transition"
      >
        history {open ? "▴" : "▾"}
      </button>
      {open ? (
        <div className="absolute z-20 right-0 mt-1 w-[min(960px,calc(100vw-2rem))] rounded border border-ink-600 bg-ink-900 shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-700 flex items-center justify-between text-[11px] text-ink-400">
            <span>
              Prior runs in parent folder
              {runs && runs.length > 0 ? <span className="ml-2 text-ink-500">({runs.length})</span> : null}
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-ink-500 hover:text-ink-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {loading ? (
              <div className="p-3 text-ink-400">Loading…</div>
            ) : error ? (
              <div className="p-3 text-red-300">Failed to load: {error}</div>
            ) : runs && runs.length === 0 ? (
              <div className="p-3 text-ink-400 italic">
                No sibling runs found in this parent folder.
              </div>
            ) : runs ? (
              // Task #86 (2026-04-25): spreadsheet-style table with
              // aligned columns + color-coded preset/result chips so
              // users can scan the history at a glance.
              <table className="w-full text-[11px] font-mono">
                <thead className="bg-ink-800/60 text-ink-500 text-left text-[10px] uppercase tracking-wider sticky top-0 z-10">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Time</th>
                    <th className="px-2 py-1.5 font-semibold">Run</th>
                    <th className="px-2 py-1.5 font-semibold">Preset</th>
                    <th className="px-2 py-1.5 font-semibold">Result</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Commits</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Todos</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Wall</th>
                    <th className="px-2 py-1.5 font-semibold">Path</th>
                    <th className="px-2 py-1.5 font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={`${r.clonePath}-${r.runId ?? r.startedAt}`}
                      className={
                        "border-t border-ink-800/60 hover:bg-ink-800/40 transition cursor-pointer " +
                        (r.isActive ? "bg-emerald-900/20" : "")
                      }
                      onClick={() => setSelected(r)}
                    >
                      <td className="px-2 py-1 text-ink-400" title={new Date(r.startedAt).toLocaleString()}>
                        {fmtTimeShort(r.startedAt)}
                      </td>
                      <td className="px-2 py-1">
                        {r.runId ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void navigator.clipboard.writeText(r.runId!);
                            }}
                            title={`Copy full runId: ${r.runId}`}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700 hover:text-ink-100 text-ink-300"
                          >
                            {r.runId.slice(0, 8)}
                          </button>
                        ) : (
                          <span className="text-ink-600 text-[10px]">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <PresetChip preset={r.preset} />
                      </td>
                      <td className="px-2 py-1">
                        {r.isActive ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700/30 border border-emerald-600/40 text-emerald-300 font-semibold">
                            ● ACTIVE
                          </span>
                        ) : r.stopReason ? (
                          <ResultChip reason={r.stopReason} />
                        ) : (
                          <span className="text-ink-600 text-[10px]">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right text-ink-300 tabular-nums">
                        {r.commits && r.commits > 0 ? r.commits : ""}
                      </td>
                      <td className="px-2 py-1 text-right text-ink-300 tabular-nums">
                        {r.totalTodos && r.totalTodos > 0 ? r.totalTodos : ""}
                      </td>
                      <td className="px-2 py-1 text-right text-ink-300 tabular-nums whitespace-nowrap">
                        {r.wallClockMs > 0 ? formatDurationCompact(r.wallClockMs) : ""}
                      </td>
                      <td className="px-2 py-1 text-ink-500 truncate max-w-[260px]" title={r.clonePath}>
                        {truncateLeft(r.clonePath, 36)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void onOpenFolder(r.clonePath);
                          }}
                          title="Open clone folder in OS file manager"
                          className="text-[10px] text-ink-400 hover:text-ink-100 underline"
                        >
                          open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      ) : null}
      {selected ? (
        <RunDigestModal digest={selected} onClose={() => setSelected(null)} />
      ) : null}
    </span>
  );
}

// Read-only modal showing a prior run's full summary (2026-04-24
// redesign): grid layout, fetches the full summary.json on open
// (was: only the thin digest), shows per-agent latency table,
// run-level counters, git status preview, contract criteria.
// Adds an "Open summary JSON" button that pops the raw JSON into
// a new tab so users can grep through what they need.
//
// Transcript replay is still deferred — the runner doesn't persist
// transcripts past run-end yet (queued as task #65). Until then,
// "review past run as if live" isn't possible.
function RunDigestModal({ digest, onClose }: { digest: RunSummaryDigest; onClose: () => void }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          clonePath: digest.clonePath,
          ...(digest.runId ? { runId: digest.runId } : {}),
        });
        const r = await fetch(`/api/swarm/run-summary?${params.toString()}`);
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as RunSummary;
        if (!cancelled) setSummary(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [digest.clonePath, digest.runId]);

  const summaryUrl = `/api/swarm/run-summary?clonePath=${encodeURIComponent(digest.clonePath)}${
    digest.runId ? `&runId=${encodeURIComponent(digest.runId)}` : ""
  }`;

  // Fall back to digest fields when the full summary fetch hasn't
  // landed yet — digest is a strict subset, so the header always
  // renders something useful.
  const head = summary ?? {
    repoUrl: "",
    localPath: digest.clonePath,
    preset: digest.preset,
    model: digest.model,
    startedAt: digest.startedAt,
    endedAt: digest.endedAt,
    wallClockMs: digest.wallClockMs,
    stopReason: (digest.stopReason ?? "") as RunSummary["stopReason"],
    commits: digest.commits ?? 0,
    staleEvents: 0,
    skippedTodos: 0,
    totalTodos: digest.totalTodos ?? 0,
    filesChanged: 0,
    finalGitStatus: "",
    finalGitStatusTruncated: false,
    agents: [] as PerAgentStat[],
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border border-ink-600 rounded-lg shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-ink-900 border-b border-ink-700 px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-ink-100 truncate">{digest.name}</h3>
            <div className="text-[10px] font-mono text-ink-500 truncate">
              {digest.runId ? `run ${digest.runId}` : "(no runId)"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-100 text-lg leading-none px-2"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Identity grid */}
          <section>
            <SectionLabel>Identity</SectionLabel>
            <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono">
              <DataLabel>Preset</DataLabel>
              <DataValue>{head.preset}</DataValue>
              <DataLabel>Model</DataLabel>
              <DataValue>{head.model}</DataValue>
              {head.repoUrl ? (
                <>
                  <DataLabel>Repo</DataLabel>
                  <DataValue>
                    <a
                      href={head.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-300 hover:text-sky-200 underline break-all"
                    >
                      {head.repoUrl}
                    </a>
                  </DataValue>
                </>
              ) : null}
              <DataLabel>Clone path</DataLabel>
              <DataValue><span className="break-all text-ink-300">{head.localPath}</span></DataValue>
              <DataLabel>Started</DataLabel>
              <DataValue>{new Date(head.startedAt).toLocaleString()}</DataValue>
              {head.endedAt > 0 ? (
                <>
                  <DataLabel>Ended</DataLabel>
                  <DataValue>{new Date(head.endedAt).toLocaleString()}</DataValue>
                </>
              ) : null}
              {head.wallClockMs > 0 ? (
                <>
                  <DataLabel>Wall-clock</DataLabel>
                  <DataValue>{formatRuntimeMs(head.wallClockMs)}</DataValue>
                </>
              ) : null}
              {head.stopReason ? (
                <>
                  <DataLabel>Stop reason</DataLabel>
                  <DataValue>{head.stopReason}</DataValue>
                </>
              ) : null}
            </div>
          </section>

          {/* Run-level counters */}
          {summary ? (
            <section>
              <SectionLabel>Counters</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Commits" value={summary.commits} />
                <Stat label="Files changed" value={summary.filesChanged} />
                <Stat label="Total todos" value={summary.totalTodos} />
                <Stat label="Skipped todos" value={summary.skippedTodos} />
                <Stat label="Stale events" value={summary.staleEvents} />
                <Stat label="Agents" value={summary.agents.length} />
              </div>
            </section>
          ) : null}

          {/* Per-agent table */}
          {summary && summary.agents.length > 0 ? (
            <section>
              <SectionLabel>Per-agent ({summary.agents.length})</SectionLabel>
              <div className="overflow-x-auto rounded border border-ink-700">
                <table className="w-full text-[11px] font-mono">
                  <thead className="bg-ink-800/60 text-ink-400 text-left">
                    <tr>
                      <th className="px-2 py-1">#</th>
                      <th className="px-2 py-1">Role</th>
                      <th className="px-2 py-1 text-right">Turns</th>
                      <th className="px-2 py-1 text-right">Attempts</th>
                      <th className="px-2 py-1 text-right">Retries</th>
                      <th className="px-2 py-1 text-right">Mean</th>
                      <th className="px-2 py-1 text-right">p50</th>
                      <th className="px-2 py-1 text-right">p95</th>
                      <th className="px-2 py-1 text-right" title="Commits this agent landed (blackboard-only)">Commits</th>
                      <th className="px-2 py-1 text-right text-emerald-400/70" title="Lines added by this agent (blackboard-only)">+Lines</th>
                      <th className="px-2 py-1 text-right text-rose-400/70" title="Lines removed by this agent (blackboard-only)">−Lines</th>
                      <th className="px-2 py-1 text-right" title="Total lines touched (added + removed)">Total</th>
                      <th className="px-2 py-1 text-right text-rose-400/70" title="Rejected work — declined todos + JSON-invalid-after-repair + CAS losses + hunk-apply failures + critic rejections (blackboard-only)">Rejected</th>
                      <th className="px-2 py-1 text-right text-amber-400/70" title="JSON-invalid first attempts that triggered the repair-prompt path (informational; successful repair still counts)">JSON⚠</th>
                      <th className="px-2 py-1 text-right text-rose-500/70" title="Hard errors during this agent's prompts (network, abort, etc.)">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.agents.map((a) => {
                      const linesTotal = a.linesAdded !== undefined && a.linesRemoved !== undefined
                        ? a.linesAdded + a.linesRemoved
                        : undefined;
                      return (
                        <tr key={a.agentId} className="border-t border-ink-700/60">
                          <td className="px-2 py-1 text-ink-300">{a.agentIndex}</td>
                          <td className="px-2 py-1 text-ink-200">{roleForRow(summary.preset, a.agentIndex, summary.agents.length)}</td>
                          <td className="px-2 py-1 text-right text-ink-200">{a.turnsTaken}</td>
                          <td className="px-2 py-1 text-right text-ink-300">{a.totalAttempts ?? "—"}</td>
                          <td className="px-2 py-1 text-right text-ink-300">{a.totalRetries ?? "—"}</td>
                          <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.meanLatencyMs)}</td>
                          <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.p50LatencyMs)}</td>
                          <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.p95LatencyMs)}</td>
                          <td className="px-2 py-1 text-right text-ink-200">{a.commits ?? "—"}</td>
                          <td className="px-2 py-1 text-right text-emerald-300">{a.linesAdded ?? "—"}</td>
                          <td className="px-2 py-1 text-right text-rose-300">{a.linesRemoved ?? "—"}</td>
                          <td className="px-2 py-1 text-right text-ink-200">{linesTotal ?? "—"}</td>
                          <td className={`px-2 py-1 text-right ${a.rejectedAttempts && a.rejectedAttempts > 0 ? "text-rose-300 font-semibold" : "text-ink-300"}`}>{a.rejectedAttempts ?? "—"}</td>
                          <td className={`px-2 py-1 text-right ${a.jsonRepairs && a.jsonRepairs > 0 ? "text-amber-300" : "text-ink-300"}`}>{a.jsonRepairs ?? "—"}</td>
                          <td className={`px-2 py-1 text-right ${a.promptErrors && a.promptErrors > 0 ? "text-rose-400 font-semibold" : "text-ink-300"}`}>{a.promptErrors ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* Contract criteria (blackboard only) */}
          {summary?.contract ? (
            <section>
              <SectionLabel>Contract — {summary.contract.criteria.length} criteria</SectionLabel>
              {summary.contract.missionStatement ? (
                <div className="text-ink-300 italic mb-1">{summary.contract.missionStatement}</div>
              ) : null}
              <ul className="space-y-1">
                {summary.contract.criteria.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <span className={
                      c.status === "met" ? "text-emerald-400"
                      : c.status === "wont-do" ? "text-amber-400"
                      : "text-ink-500"
                    }>
                      {c.status === "met" ? "✓" : c.status === "wont-do" ? "✕" : "○"}
                    </span>
                    <span className="text-ink-300">{c.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Final git status */}
          {summary?.finalGitStatus ? (
            <section>
              <SectionLabel>
                Final git status
                {summary.finalGitStatusTruncated ? <span className="text-amber-400"> (truncated)</span> : null}
              </SectionLabel>
              <pre className="text-[10px] font-mono text-ink-400 bg-ink-950/60 border border-ink-700 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
                {summary.finalGitStatus.trim() || "(clean)"}
              </pre>
            </section>
          ) : null}

          {/* Loading / error state */}
          {loading ? (
            <div className="text-ink-500 italic">Loading full summary…</div>
          ) : null}
          {error && !summary ? (
            <div className="text-rose-300">Failed to load full summary: {error}</div>
          ) : null}
          {!loading && !error && !summary ? (
            <div className="text-ink-500 italic">
              No matching summary on disk. Showing digest only.
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-ink-900 border-t border-ink-700 px-5 py-3 flex flex-wrap justify-end gap-2">
          {/* Task #65: open the run in a fresh tab as if it were live —
              new tab parses ?review + ?path, hydrates store from the
              saved summary, and reuses SwarmView's existing panels
              (transcript / metrics / agent cards). Disabled when the
              summary has no transcript (legacy runs predate task #65). */}
          {digest.runId ? (
            <a
              href={`/?review=${encodeURIComponent(digest.runId)}&path=${encodeURIComponent(digest.clonePath)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={summary?.transcript
                ? `Replay this run in a new tab (${summary.transcript.length} transcript entries)`
                : "Open the run in a new tab — transcript replay only works on runs after task #65 landed"}
              className="text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100 border border-emerald-600 font-medium"
            >
              Open run review ↗
            </a>
          ) : null}
          <a
            href={summaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Open summary JSON ↗
          </a>
          <button
            onClick={() => {
              void fetch("/api/swarm/open", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: digest.clonePath }),
              }).catch(() => {});
            }}
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Open folder
          </button>
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
      {children}
    </div>
  );
}

function DataLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-500">{children}</div>;
}

function DataValue({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-200 min-w-0">{children}</div>;
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  // 2026-04-25 fine-tune: blank-out 0 + undefined (Kevin's preference
  // — empty cell reads cleaner than "—" or "0"). Defensive against
  // discussion-preset summaries where blackboard-only fields are
  // undefined; also avoids the original undefined.toLocaleString crash.
  const display = !value ? "" : value.toLocaleString();
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="text-ink-100 font-mono text-sm min-h-[1.25rem]">{display}</div>
    </div>
  );
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Mirror of agentRole() inside SwarmView — modal only knows preset
// + index, not the live runConfig. Kept in sync so dropdown rows
// show the same role names users see in AgentPanel during a run.
function roleForRow(preset: string, idx: number, totalAgents: number): string {
  switch (preset) {
    case "blackboard":
      if (idx === 1) return "planner";
      if (idx > totalAgents - 1) return "auditor";
      return "worker";
    case "orchestrator-worker":
      return idx === 1 ? "orchestrator" : "worker";
    case "map-reduce":
      return idx === 1 ? "reducer" : "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      if (idx === 1) return "pro";
      if (idx === 2) return "con";
      if (idx === 3) return "judge";
      return "peer";
    default:
      return idx === 1 ? "planner" : "worker";
  }
}

// 2026-04-25 fine-tune: two duration formatters per Kevin.
//
// formatDurationCompact — colon-digital for the history dropdown
//   table where the column is narrow and rows benefit from
//   tight scannable runtimes:
//     1m 4s        → "1:4"
//     12h 12m 13s  → "12:12:13"
//     4d 15h 12m 12s → "4:15:12:12"
//     30s alone    → "0:30" (always show m:s — matches stopwatch)
//
// formatRuntimeMs — spaced "3 m 24 s" for the modal's Identity
//   grid where there's room and English units read better at
//   review time.
function formatDurationCompact(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}:${h}:${m}:${s}`;
  if (h > 0) return `${h}:${m}:${s}`;
  return `${m}:${s}`;
}
function formatRuntimeMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} d ${h} h ${m} m ${s} s`;
  if (h > 0) return `${h} h ${m} m ${s} s`;
  if (m > 0) return `${m} m ${s} s`;
  return `${s} s`;
}

// Unit 56: CopyChip moved to its own file (./CopyChip.tsx) so AgentPanel
// can import it too.

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}
// Task #86 (2026-04-25): color-coded chip per swarm preset. Same
// hue per preset across the dropdown + (future) anywhere else
// preset names appear, so users build muscle memory for "council
// = sky, blackboard = emerald, debate-judge = amber" etc.
const PRESET_CHIP_STYLES: Record<string, string> = {
  blackboard: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  council: "bg-sky-900/40 border-sky-700/50 text-sky-200",
  "orchestrator-worker": "bg-amber-900/40 border-amber-700/50 text-amber-200",
  "map-reduce": "bg-violet-900/40 border-violet-700/50 text-violet-200",
  "role-diff": "bg-fuchsia-900/40 border-fuchsia-700/50 text-fuchsia-200",
  "debate-judge": "bg-rose-900/40 border-rose-700/50 text-rose-200",
  stigmergy: "bg-teal-900/40 border-teal-700/50 text-teal-200",
  "round-robin": "bg-ink-700 border-ink-600 text-ink-200",
};
function PresetChip({ preset }: { preset: string }) {
  const cls = PRESET_CHIP_STYLES[preset] ?? "bg-ink-700 border-ink-600 text-ink-200";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${cls}`}>
      {preset}
    </span>
  );
}

// Task #86: stopReason chip with semantic coloring. Distinguishes
// natural completion from user-stop from cap-trip from crash.
function ResultChip({ reason }: { reason: string }) {
  let cls = "bg-ink-700 border-ink-600 text-ink-300";
  let label = reason;
  if (reason === "completed") {
    cls = "bg-emerald-900/40 border-emerald-700/50 text-emerald-300";
    label = "completed";
  } else if (reason === "user") {
    cls = "bg-ink-800 border-ink-700 text-ink-400";
    label = "stopped";
  } else if (reason === "crash" || reason === "failed") {
    cls = "bg-rose-900/40 border-rose-700/50 text-rose-300";
    label = "crashed";
  } else if (reason.startsWith("cap:")) {
    cls = "bg-amber-900/40 border-amber-700/50 text-amber-300";
    label = reason.replace("cap:", "cap·");
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${cls}`}>
      {label}
    </span>
  );
}

// 2026-04-25 fine-tune: always show date alongside time per Kevin's
// review. Today's runs cluster at the top of the dropdown so the date
// is helpful to anchor "this run was yesterday" vs "this morning."
function fmtTimeShort(ts: number): string {
  const d = new Date(ts);
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
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
