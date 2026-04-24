import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";
import type { RunSummaryDigest } from "../types";
import { AgentPanel } from "./AgentPanel";
import { BoardView } from "./BoardView";
import { ContractPanel } from "./ContractPanel";
import { CopyChip } from "./CopyChip";
import { Transcript } from "./Transcript";
import { MetricsPanel } from "./MetricsPanel";

type Tab = "transcript" | "metrics" | "board" | "contract";

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
  // If the current tab becomes hidden (user switched presets while on
  // Contract), fall back to Transcript so the content area isn't empty.
  useEffect(() => {
    if (!showBlackboardTabs && (tab === "board" || tab === "contract")) {
      setTab("transcript");
    }
  }, [showBlackboardTabs, tab]);

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
                      <span>{r.commits !== undefined ? `${r.commits} commits` : ""}</span>
                      <span>{r.totalTodos !== undefined ? `${r.totalTodos} todos` : ""}</span>
                      <span>{r.stopReason ? `→ ${r.stopReason}` : ""}</span>
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

// Unit 52e: read-only modal showing a prior run's headline summary.
// Doesn't replay the event log (deferred to a future unit) — just
// names what happened in that run.
function RunDigestModal({ digest, onClose }: { digest: RunSummaryDigest; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border border-ink-600 rounded-lg shadow-2xl max-w-xl w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-lg font-semibold">{digest.name}</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-100">
            ✕
          </button>
        </div>
        <div className="text-xs font-mono text-ink-400 space-y-1">
          <div>Started: {new Date(digest.startedAt).toLocaleString()}</div>
          {digest.endedAt > 0 ? (
            <div>Ended: {new Date(digest.endedAt).toLocaleString()}</div>
          ) : null}
          {digest.wallClockMs > 0 ? (
            <div>Wall-clock: {formatRuntimeMs(digest.wallClockMs)}</div>
          ) : null}
          <div>Preset: {digest.preset}</div>
          <div>Model: {digest.model}</div>
          {digest.commits !== undefined ? <div>Commits: {digest.commits}</div> : null}
          {digest.totalTodos !== undefined ? <div>Total todos: {digest.totalTodos}</div> : null}
          {digest.stopReason ? <div>Stop reason: {digest.stopReason}</div> : null}
          <div title={digest.clonePath}>
            Path: <span className="text-ink-300">{truncateLeft(digest.clonePath, 60)}</span>
          </div>
        </div>
        <div className="text-xs text-ink-500 italic">
          Read-only. Event-log replay is deferred to a future unit; for now,
          inspect the clone folder to see what landed.
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-ink-700">
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
