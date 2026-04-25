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
        {agentList.length === 0 ? (
          <div className="text-xs text-ink-400">No agents yet.</div>
        ) : null}
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
  const history = (
    <span className="ml-auto pl-3 flex items-center gap-2">
      <RunHistoryDropdown />
    </span>
  );
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
function RunHistoryDropdown() {
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
        <div className="absolute z-20 right-0 mt-1 w-[min(560px,calc(100vw-2rem))] rounded border border-ink-600 bg-ink-900 shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-700 flex items-center justify-between text-[11px] text-ink-400">
            <span>Prior runs in parent folder</span>
            <button
              onClick={() => setOpen(false)}
              className="text-ink-500 hover:text-ink-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="p-3 text-ink-400">Loading…</div>
            ) : error ? (
              <div className="p-3 text-red-300">Failed to load: {error}</div>
            ) : runs && runs.length === 0 ? (
              <div className="p-3 text-ink-400 italic">
                No sibling runs found in this parent folder.
              </div>
            ) : runs ? (
              <ul>
                {runs.map((r) => (
                  <li
                    key={r.clonePath}
                    className={
                      "px-3 py-2 border-b border-ink-800 hover:bg-ink-800/60 transition cursor-pointer " +
                      (r.isActive ? "bg-emerald-900/20" : "")
                    }
                    onClick={() => setSelected(r)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink-100 truncate">{r.name}</span>
                      <span className="text-[10px] text-ink-500 font-mono shrink-0">
                        {r.isActive ? "active · " : ""}
                        {new Date(r.startedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-400 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {/* Task #36: runId chip first, matches the live
                          IdentityStrip chip so users can cross-reference
                          a transcript mention like "run 73026b78" to a
                          specific row in this dropdown. Click-to-copy
                          full uuid; renders "—" for legacy rows without
                          a recorded runId. */}
                      {r.runId ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void navigator.clipboard.writeText(r.runId!);
                          }}
                          title={`Copy full runId: ${r.runId}`}
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700 hover:text-ink-100"
                        >
                          {r.runId.slice(0, 8)}
                        </button>
                      ) : (
                        <span
                          title="runId not recorded (run predates task #36)"
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-ink-900/40 border border-ink-800 text-ink-600"
                        >
                          —
                        </span>
                      )}
                      <span>preset {r.preset}</span>
                      {r.commits !== undefined ? <span>{r.commits} commits</span> : null}
                      {r.totalTodos !== undefined ? <span>{r.totalTodos} todos</span> : null}
                      {r.stopReason ? <span>→ {r.stopReason}</span> : null}
                      {/* clonePath inline (2026-04-24): for non-blackboard
                          presets the row was nearly empty mid-flight (no
                          commits / no todos / no stopReason yet), making it
                          hard to tell which target a row referred to. The
                          path is the most useful "which run is this" cue;
                          truncate-from-left so the run-name tail wins
                          screen real estate over the shared mount prefix. */}
                      <span
                        className="font-mono text-[10px] text-ink-500 truncate"
                        title={r.clonePath}
                      >
                        {truncateLeft(r.clonePath, 50)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void onOpenFolder(r.clonePath);
                        }}
                        className="ml-auto text-ink-400 hover:text-ink-100 underline"
                      >
                        open folder
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="text-ink-100 font-mono text-sm">{value.toLocaleString()}</div>
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

function formatRuntimeMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

// Unit 56: CopyChip moved to its own file (./CopyChip.tsx) so AgentPanel
// can import it too.

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
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
