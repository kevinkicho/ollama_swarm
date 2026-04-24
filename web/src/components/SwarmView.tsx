import { useState } from "react";
import { useSwarm } from "../state/store";
import { AgentPanel } from "./AgentPanel";
import { BoardView } from "./BoardView";
import { ContractPanel } from "./ContractPanel";
import { Transcript } from "./Transcript";

type Tab = "transcript" | "board" | "contract";

export function SwarmView() {
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);
  const setError = useSwarm((s) => s.setError);
  const [sayText, setSayText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");

  const reset = useSwarm((s) => s.reset);
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);
  const isTerminal = phase === "completed" || phase === "stopped" || phase === "failed";

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

  return (
    <div className="h-full flex flex-col">
      <CloneBanner />
      <IdentityStrip />
      <IdentifiersRow />
      <div className="flex-1 grid grid-cols-[260px_1fr] min-h-0">
      <aside className="border-r border-ink-700 p-3 overflow-y-auto space-y-2 bg-ink-800">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">Agents</div>
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
          <AgentPanel key={a.id} agent={a} />
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
          <TabButton active={tab === "board"} onClick={() => setTab("board")}>
            Board
          </TabButton>
          <TabButton active={tab === "contract"} onClick={() => setTab("contract")}>
            Contract
          </TabButton>
        </div>
        <div className="flex-1 overflow-hidden">
          {tab === "transcript" ? <Transcript /> : tab === "board" ? <BoardView /> : <ContractPanel />}
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

// Unit 52c: persistent strip under the header showing the run's
// identity — preset + per-agent models + clone path. The path is
// click-to-open via POST /api/swarm/open (server validates the
// request matches the active run's clonePath, then shells out to
// Explorer/Finder/xdg-open).
function IdentityStrip() {
  const cfg = useSwarm((s) => s.runConfig);
  if (!cfg) return null;
  const runName = deriveRunName(cfg.clonePath);
  const onOpen = async () => {
    try {
      const res = await fetch("/api/swarm/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: cfg.clonePath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Soft failure — log to console rather than spam the user.
        console.warn("open clone path failed:", body.error ?? res.status);
      }
    } catch (err) {
      console.warn("open clone path failed:", err);
    }
  };
  const sameModel = cfg.plannerModel === cfg.workerModel;
  return (
    <div className="bg-ink-900/60 border-b border-ink-700 px-4 py-1.5 flex items-center gap-3 text-xs font-mono text-ink-300">
      <span className="text-ink-100 font-semibold">{runName}</span>
      <span className="text-ink-600">·</span>
      <span title="Preset"><span className="text-ink-500">preset</span> {cfg.preset}</span>
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
      <span className="text-ink-600">·</span>
      <span><span className="text-ink-500">agents</span> {cfg.agentCount}</span>
      <span className="flex-1 text-right">
        <button
          onClick={onOpen}
          title={`Open in OS file manager — ${cfg.clonePath}`}
          className="text-ink-400 hover:text-ink-100 hover:underline truncate max-w-md inline-block align-bottom"
        >
          {truncateLeft(cfg.clonePath, 60)}
        </button>
      </span>
    </div>
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

// Unit 52d: compact identifiers row under the IdentityStrip. Shows
// the app runId (new uuid), each agent's opencode session id, and
// the model slugs. Every ID is click-to-copy — specifically the
// opencode session ids are what you'd grep `logs/current.jsonl`
// for to debug a single agent's prompts.
function IdentifiersRow() {
  const runId = useSwarm((s) => s.runId);
  const agents = useSwarm((s) => s.agents);
  const cfg = useSwarm((s) => s.runConfig);
  if (!runId && !cfg) return null;
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);
  const sameModel = cfg && cfg.plannerModel === cfg.workerModel;
  return (
    <div className="bg-ink-900/40 border-b border-ink-700 px-4 py-1 flex items-center gap-3 text-[11px] font-mono text-ink-400 flex-wrap">
      {runId ? (
        <CopyChip label="run" value={runId} short={runId.slice(0, 8)} />
      ) : null}
      {agentList.map((a) =>
        a.sessionId ? (
          <CopyChip
            key={a.id}
            label={a.id}
            value={a.sessionId}
            short={a.sessionId.slice(0, 12) + "…"}
          />
        ) : null,
      )}
      {cfg ? (
        sameModel ? (
          <CopyChip label="model" value={cfg.plannerModel} short={cfg.plannerModel} />
        ) : (
          <>
            <CopyChip label="planner" value={cfg.plannerModel} short={cfg.plannerModel} />
            <CopyChip label="worker" value={cfg.workerModel} short={cfg.workerModel} />
          </>
        )
      ) : null}
    </div>
  );
}

// Click-to-copy chip. Shows `<label> <short>` with the full value
// as the tooltip. Clicking copies the full value to clipboard and
// briefly flashes a checkmark. Silently no-ops if the clipboard
// API isn't available (older browsers / insecure contexts).
function CopyChip({ label, value, short }: { label: string; value: string; short: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // no-op: clipboard unavailable
    }
  };
  return (
    <button
      onClick={onClick}
      title={`${label}: ${value}  (click to copy)`}
      className="inline-flex items-baseline gap-1.5 hover:text-ink-200 hover:bg-ink-800/70 rounded px-1.5 py-0.5 border border-transparent hover:border-ink-700 transition"
    >
      <span className="text-ink-500">{label}</span>
      <span>{short}</span>
      <span className="text-emerald-400 text-[10px] w-2">{copied ? "✓" : ""}</span>
    </button>
  );
}

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
