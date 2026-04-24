import { useEffect, useState } from "react";
import { useSwarm } from "./state/store";
import { useSwarmSocket } from "./hooks/useSwarmSocket";
import { SetupForm } from "./components/SetupForm";
import { SwarmView } from "./components/SwarmView";

export default function App() {
  useSwarmSocket();
  const phase = useSwarm((s) => s.phase);
  const error = useSwarm((s) => s.error);

  // Once a swarm has started, keep the user on SwarmView even after the loop
  // completes or they hit Stop — they need to read the transcript. They return
  // to setup only via the explicit "Start new swarm" button (which resets).
  const showSetup = phase === "idle";

  return (
    <div className="h-full flex flex-col">
      <header className="px-6 py-3 border-b border-ink-700 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">ollama_swarm</h1>
          <span className="text-xs text-ink-400 font-mono">glm-5.1:cloud · opencode</span>
        </div>
        <div className="flex items-center gap-3">
          <RuntimeTicker />
          <PhasePill />
        </div>
      </header>
      {error ? (
        <div className="px-6 py-2 bg-red-900/40 text-red-200 text-sm border-b border-red-900">
          {error}
        </div>
      ) : null}
      <main className="flex-1 overflow-hidden">
        {showSetup ? <SetupForm /> : <SwarmView />}
      </main>
    </div>
  );
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
