import { useEffect, useState } from "react";
import { useSwarm } from "./state/store";
import { useSwarmSocket } from "./hooks/useSwarmSocket";
import { SetupForm } from "./components/SetupForm";
import { SwarmView } from "./components/SwarmView";
import { RunHistoryDropdown } from "./components/RunHistory";
import { EventLogPanel } from "./components/EventLogPanel";
import { UsageWidget } from "./components/UsageWidget";
import { ErrorBanner } from "./components/ErrorBanner";
import type { RunSummary } from "./types";

// Task #65 (2026-04-24): URL-based review mode. When the user opens a
// past run from the history modal we set ?review=<runId>&path=<encoded>.
// In that mode the app skips the live WebSocket and instead hydrates
// the store from the saved summary (which now persists transcript +
// agent stats), so existing components — IdentityStrip, AgentPanel,
// Transcript, MetricsPanel — render the past run as if it were live.
function parseReviewParams(): { runId: string; clonePath: string } | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  const runId = sp.get("review");
  const clonePath = sp.get("path");
  if (!runId || !clonePath) return null;
  return { runId, clonePath };
}

export default function App() {
  const review = parseReviewParams();
  // Skip the live WS in review mode; the saved summary is the source.
  useSwarmSocket(review === null);
  useReviewHydration(review);
  const phase = useSwarm((s) => s.phase);
  const error = useSwarm((s) => s.error);

  // Task #163: when in review mode, poll /api/swarm/status to detect
  // whether the run being reviewed is ALSO the currently-live run. If
  // yes, surface "View Live" + "Stop" buttons next to the REVIEW MODE
  // badge so the user can switch to the live view or abort without
  // hunting for the controls.
  const reviewedRunIsLive = useReviewedRunIsLive(review);

  // Once a swarm has started, keep the user on SwarmView even after the loop
  // completes or they hit Stop — they need to read the transcript. They return
  // to setup only via the explicit "Start new swarm" button (which resets).
  // In review mode we always show SwarmView (never the setup form).
  const showSetup = review === null && phase === "idle";

  return (
    <div className="h-full flex flex-col">
      <header className="px-6 py-3 border-b border-ink-700 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">ollama_swarm</h1>
          {review ? (
            <>
              <span className="text-xs text-amber-300 font-mono px-2 py-0.5 rounded bg-amber-950/40 border border-amber-700/50">
                REVIEW MODE · run {review.runId.slice(0, 8)}
              </span>
              {reviewedRunIsLive ? (
                <ReviewActiveControls />
              ) : null}
            </>
          ) : (
            <span className="text-xs text-ink-400 font-mono">glm-5.1:cloud · opencode</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <RuntimeTicker />
          <PhasePill />
          {/* Task #125: token-usage widget. Shows rolling 1h/5h/24h/7d
              consumption pulled from the Ollama proxy (#133). User
              supplies their own caps — Ollama doesn't expose
              subscription quotas via API. */}
          <UsageWidget />
          {/* Task #85: history dropdown lives in the App header so it's
              accessible even before any run starts (SetupForm flash
              page). The /api/swarm/runs route falls back to
              lastParentPath when no run is active, so the dropdown
              still loads recent history without a current run. */}
          <RunHistoryDropdown />
          {/* V2 Step 6b: read-only event-log viewer (logs/current.jsonl
              parsed via EventLogReaderV2 + summarized server-side). */}
          <EventLogPanel />
        </div>
      </header>
      {error ? <ErrorBanner error={error} /> : null}
      <main className="flex-1 overflow-hidden">
        {showSetup ? <SetupForm /> : <SwarmView />}
      </main>
    </div>
  );
}

// Task #163: poll /api/swarm/status while in review mode to detect
// whether the reviewed run is the currently-active live run. Returns
// true once status.runId matches review.runId (and stays true until
// the live run ends or the user navigates away).
function useReviewedRunIsLive(review: { runId: string; clonePath: string } | null): boolean {
  const [isLive, setIsLive] = useState(false);
  useEffect(() => {
    if (!review) {
      setIsLive(false);
      return;
    }
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch("/api/swarm/status");
        if (!r.ok) return;
        const body = (await r.json()) as { runId?: string };
        if (!cancelled) setIsLive(body.runId === review!.runId);
      } catch {
        // ignore — next tick will retry
      }
    }
    void check();
    const t = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [review]);
  return isLive;
}

// Task #163: control row shown in REVIEW MODE when the reviewed run is
// the live one. Single "View Live" button exits review mode (clears the
// ?review URL params and reloads). The Stop button lives in live mode
// (SwarmView header), not here — review mode is for inspection, not
// control. Once the user hits "View Live", they get the existing Stop
// button in SwarmView.
function ReviewActiveControls() {
  const onViewLive = () => {
    // Clear the review params and reload — re-mount drops review mode
    // and re-attaches the live WebSocket.
    const url = new URL(window.location.href);
    url.searchParams.delete("review");
    url.searchParams.delete("path");
    window.location.href = url.toString();
  };
  return (
    <span className="flex items-center gap-2">
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700/30 border border-emerald-600/40 text-emerald-300 font-semibold">
        ● live
      </span>
      <button
        onClick={onViewLive}
        title="Switch out of REVIEW MODE and connect to the live WebSocket for this run (the Stop button is in the live view)"
        className="text-xs px-2 py-0.5 rounded border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/40 hover:border-emerald-600 transition"
      >
        View Live ↗
      </button>
    </span>
  );
}

// Hydrates the store from a saved RunSummary so the existing live-view
// components render a past run. Only runs in review mode; no-op otherwise.
function useReviewHydration(review: { runId: string; clonePath: string } | null) {
  const setRunId = useSwarm((s) => s.setRunId);
  const setRunStartedAt = useSwarm((s) => s.setRunStartedAt);
  const setRunConfig = useSwarm((s) => s.setRunConfig);
  const setSummary = useSwarm((s) => s.setSummary);
  const setContract = useSwarm((s) => s.setContract);
  const appendEntry = useSwarm((s) => s.appendEntry);
  const setError = useSwarm((s) => s.setError);
  const setPhase = useSwarm((s) => s.setPhase);

  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          clonePath: review.clonePath,
          runId: review.runId,
        });
        const r = await fetch(`/api/swarm/run-summary?${params.toString()}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const summary = (await r.json()) as RunSummary;
        if (cancelled) return;
        // Hydrate identity + ticker + topbar.
        setRunId(review.runId);
        setRunStartedAt(summary.startedAt);
        setRunConfig({
          preset: summary.preset,
          plannerModel: summary.model,
          workerModel: summary.model,
          auditorModel: summary.model,
          dedicatedAuditor: false,
          repoUrl: summary.repoUrl,
          clonePath: summary.localPath,
          agentCount: summary.agents.length,
          rounds: 0,
        });
        setSummary(summary);
        if (summary.contract) setContract(summary.contract);
        // Replay transcript through the existing append path so
        // Transcript / MetricsPanel / etc. don't need to know they're
        // looking at a snapshot.
        if (summary.transcript) {
          for (const e of summary.transcript) appendEntry(e);
        }
        // Phase is whatever the run terminated as; map stopReason →
        // a display phase that makes the PhasePill render sensibly.
        const phase = summary.stopReason === "completed" ? "completed"
          : summary.stopReason === "user" || summary.stopReason === "crash" ? "stopped"
          : "completed";
        setPhase(phase, 0);
      } catch (err) {
        if (!cancelled) {
          setError(`Review hydration failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Hydrate once per (runId, clonePath); store setters are stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.runId, review?.clonePath]);
}

// Unit 52b: replaced the bare-phase pill with a composite signal —
// "executing · 21/30 todos", "stopping · waiting on 3 agents", etc.
// The full breakdown lives in the tooltip so the badge stays compact.
function PhasePill() {
  const phase = useSwarm((s) => s.phase);
  const round = useSwarm((s) => s.round);
  const todos = useSwarm((s) => s.todos);
  const agents = useSwarm((s) => s.agents);
  const contract = useSwarm((s) => s.contract);
  const summary = useSwarm((s) => s.summary);

  const color: Record<string, string> = {
    idle: "bg-ink-600 text-ink-100",
    cloning: "bg-blue-700 text-blue-100",
    spawning: "bg-amber-700 text-amber-100",
    seeding: "bg-amber-700 text-amber-100",
    planning: "bg-amber-700 text-amber-100",
    discussing: "bg-emerald-700 text-emerald-100",
    executing: "bg-emerald-700 text-emerald-100",
    stopping: "bg-red-700 text-red-100",
    stopped: "bg-ink-600 text-ink-100",
    failed: "bg-red-900 text-red-100",
    completed: "bg-emerald-900 text-emerald-100",
  };

  // Derived board counts (mirrors BoardCounts on the server side).
  const todoList = Object.values(todos);
  const counts = {
    open: 0,
    claimed: 0,
    committed: 0,
    stale: 0,
    skipped: 0,
    total: todoList.length,
  };
  for (const t of todoList) {
    if (t.status === "open") counts.open++;
    else if (t.status === "claimed") counts.claimed++;
    else if (t.status === "committed") counts.committed++;
    else if (t.status === "stale") counts.stale++;
    else if (t.status === "skipped") counts.skipped++;
  }

  // Agent vital signs.
  const agentList = Object.values(agents);
  const aliveAgents = agentList.filter((a) => a.status !== "stopped" && a.status !== "failed").length;
  const thinkingAgents = agentList.filter((a) => a.status === "thinking").length;

  // Phase → composite suffix. Empty string keeps the bare phase.
  let suffix = "";
  switch (phase) {
    case "discussing":
      suffix = ` · round ${round}`;
      break;
    case "spawning":
      if (agentList.length > 0) suffix = ` · ${agentList.length} agents`;
      break;
    case "planning":
      if (contract && contract.criteria.length > 0) {
        suffix = ` · ${contract.criteria.length} criteria`;
      }
      break;
    case "executing":
      if (counts.total > 0) {
        suffix = ` · ${counts.committed}/${counts.total} todos`;
        if (thinkingAgents > 0) suffix += ` · ${thinkingAgents} thinking`;
      }
      break;
    case "stopping":
      if (aliveAgents > 0) suffix = ` · waiting on ${aliveAgents} agent${aliveAgents === 1 ? "" : "s"}`;
      break;
    case "completed":
    case "stopped":
    case "failed":
      // Prefer the authoritative summary number once it lands.
      const finalCommits = summary?.commits ?? counts.committed;
      if (finalCommits > 0) suffix = ` · ${finalCommits} commits`;
      break;
  }

  // Tooltip: full board + agent breakdown. Stays out of the badge
  // text so the pill is glanceable.
  const tooltip = buildTooltip({ phase, round, counts, agentList, contract });

  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap ${color[phase] ?? "bg-ink-600"}`}
      title={tooltip}
    >
      {phase}
      {suffix}
    </span>
  );
}

interface PillTooltipInput {
  phase: string;
  round: number;
  counts: { open: number; claimed: number; committed: number; stale: number; skipped: number; total: number };
  agentList: Array<{ id: string; status: string }>;
  contract: { criteria: Array<{ status: string }> } | undefined;
}
function buildTooltip(input: PillTooltipInput): string {
  const lines: string[] = [`Phase: ${input.phase}`];
  if (input.round > 0) lines.push(`Round: ${input.round}`);
  if (input.counts.total > 0) {
    lines.push(
      `Todos: ${input.counts.committed} committed · ${input.counts.open} open · ${input.counts.claimed} claimed · ${input.counts.stale} stale · ${input.counts.skipped} skipped (${input.counts.total} total)`,
    );
  }
  if (input.agentList.length > 0) {
    const byStatus: Record<string, number> = {};
    for (const a of input.agentList) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const summary = Object.entries(byStatus)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    lines.push(`Agents: ${summary}`);
  }
  if (input.contract && input.contract.criteria.length > 0) {
    const met = input.contract.criteria.filter((c) => c.status === "met").length;
    const wontDo = input.contract.criteria.filter((c) => c.status === "wont-do").length;
    const unmet = input.contract.criteria.length - met - wontDo;
    lines.push(`Criteria: ${met} met · ${unmet} unmet · ${wontDo} wont-do`);
  }
  return lines.join("\n");
}

// Unit 52a: wall-clock ticker anchored on the run_started event.
// Ticks every 1s while the run is live; freezes on terminal phases
// using the summary's wallClockMs (preferred) or final live delta.
// Hidden when no run has started in this session yet.
function RuntimeTicker() {
  const startedAt = useSwarm((s) => s.runStartedAt);
  const phase = useSwarm((s) => s.phase);
  const summary = useSwarm((s) => s.summary);
  const isTerminal = phase === "completed" || phase === "stopped" || phase === "failed";
  // Live tick while running. Stop the interval on terminal phases so
  // we don't burn CPU re-rendering the same frozen value every 1s.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isTerminal || startedAt === undefined) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [isTerminal, startedAt]);
  if (startedAt === undefined) return null;
  // Prefer the summary's authoritative wallClockMs if the run is
  // terminal AND a summary has landed. Falls back to live delta
  // otherwise — covers the brief window between phase=completed and
  // run_summary arriving, and the user-stop case where summary may
  // not be written until after the kill cascade.
  const elapsedMs = isTerminal && summary?.wallClockMs !== undefined
    ? summary.wallClockMs
    : Math.max(0, Date.now() - startedAt);
  return (
    <span
      className={
        "text-xs font-mono tabular-nums " +
        (isTerminal ? "text-ink-400" : "text-ink-300")
      }
      title={`Run started ${new Date(startedAt).toLocaleString()}`}
    >
      {formatRuntime(elapsedMs)}
    </span>
  );
}

function formatRuntime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
