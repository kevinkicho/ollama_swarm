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

function PhasePill() {
  const phase = useSwarm((s) => s.phase);
  const round = useSwarm((s) => s.round);
  const color: Record<string, string> = {
    idle: "bg-ink-600 text-ink-100",
    cloning: "bg-blue-700 text-blue-100",
    spawning: "bg-amber-700 text-amber-100",
    seeding: "bg-amber-700 text-amber-100",
    discussing: "bg-emerald-700 text-emerald-100",
    stopping: "bg-red-700 text-red-100",
    stopped: "bg-ink-600 text-ink-100",
    completed: "bg-emerald-900 text-emerald-100",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono ${color[phase] ?? "bg-ink-600"}`}>
      {phase}
      {phase === "discussing" ? ` · round ${round}` : ""}
    </span>
  );
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
