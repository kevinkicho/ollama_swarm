import { useEffect, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import { displaySwarmPhase, isTerminalSwarmPhase } from "../lib/swarmPhase";

// Simplified run status for the topbar (no granular planning/executing/discussing labels).
export function PhasePill() {
  const phase = useSwarm((s) => s.phase);
  const round = useSwarm((s) => s.round);
  const todos = useSwarm((s) => s.todos);
  const agents = useSwarm((s) => s.agents);
  const summary = useSwarm((s) => s.summary);

  const label = displaySwarmPhase(phase);

  const color: Record<string, string> = {
    idle: "bg-ink-600 text-ink-100",
    running: "bg-emerald-700 text-emerald-100",
    stopped: "bg-ink-600 text-ink-100",
    failed: "bg-red-900 text-red-100",
    completed: "bg-emerald-900 text-emerald-100",
  };

  const todoList = Object.values(todos);
  let committed = 0;
  let total = todoList.length;
  for (const t of todoList) {
    if (t.status === "committed") committed++;
  }

  const agentList = Object.values(agents);
  const thinkingAgents = agentList.filter((a) => a.status === "thinking").length;

  let suffix = "";
  if (label === "running") {
    const parts: string[] = [];
    if (round > 0) parts.push(`round ${round}`);
    if (total > 0) parts.push(`${committed}/${total} todos`);
    if (thinkingAgents > 0) parts.push(`${thinkingAgents} thinking`);
    if (parts.length > 0) suffix = ` · ${parts.join(" · ")}`;
  } else if (isTerminalSwarmPhase(phase)) {
    const finalCommits = summary?.commits ?? committed;
    if (finalCommits > 0) suffix = ` · ${finalCommits} commits`;
  }

  const tooltip = [
    "Run status pill — simplified lifecycle for the run you're viewing.",
    `Status: ${label}${phase !== label ? ` (runner phase: ${phase})` : ""}`,
    label === "running"
      ? "Agents may still be prompting, executing todos, or discussing."
      : label === "failed"
        ? "Run ended with an error — check transcript and run summary."
        : label === "stopped"
          ? "Run was stopped by user or cap before natural completion."
          : label === "completed"
            ? "Run finished normally — see summary for commits and contract outcomes."
            : "No run in progress.",
    round > 0 ? `Round: ${round}` : null,
    total > 0 ? `Todos committed: ${committed}/${total}` : null,
    thinkingAgents > 0 ? `Agents thinking now: ${thinkingAgents}` : null,
    agentList.length > 0 ? `Agents spawned: ${agentList.length}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap ${color[label] ?? "bg-ink-600"}`}
      title={tooltip}
    >
      {label}
      {suffix}
    </span>
  );
}

// Unit 52a: wall-clock ticker anchored on run_started.
function ProviderQueueChip() {
  const runId = useSwarm((s) => s.runId);
  const [queueDepth, setQueueDepth] = useState(0);
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/providers");
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          gateway?: {
            totalQueueDepth?: number;
            providers?: Record<string, { queueDepth: number }>;
          };
        };
        if (cancelled) return;
        const total =
          body.gateway?.totalQueueDepth ??
          Object.values(body.gateway?.providers ?? {}).reduce(
            (n, p) => n + (p.queueDepth ?? 0),
            0,
          );
        setQueueDepth(total);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);
  if (queueDepth <= 0) return null;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-amber-900/30 text-amber-200 border border-amber-700/40"
      title="Provider queue — LLM requests waiting for shared API capacity (Ollama/Anthropic/OpenAI gateway). Clears as slots free up."
    >
      queue {queueDepth}
    </span>
  );
}

// Unit 52a: wall-clock ticker anchored on run_started.
export function RuntimeTicker() {
  const startedAt = useSwarm((s) => s.runStartedAt);
  const phase = useSwarm((s) => s.phase);
  const summary = useSwarm((s) => s.summary);
  const hasTerminalSummary = !!summary && (!!summary.stopReason || typeof summary.endedAt === 'number' || typeof summary.wallClockMs === 'number');
  const isTerminal = hasTerminalSummary || isTerminalSwarmPhase(phase);
  const [, setTick] = useState(0);

  const frozenElapsedRef = useRef<number | null>(null);
  useEffect(() => {
    if (isTerminal && startedAt !== undefined && frozenElapsedRef.current === null) {
      if (summary?.wallClockMs !== undefined) {
        frozenElapsedRef.current = summary.wallClockMs;
      } else if (summary?.endedAt && startedAt) {
        frozenElapsedRef.current = Math.max(0, summary.endedAt - startedAt);
      } else {
        frozenElapsedRef.current = Math.max(0, Date.now() - startedAt);
      }
    }
  }, [isTerminal, startedAt, summary?.wallClockMs, summary?.endedAt]);

  useEffect(() => {
    if (isTerminal || startedAt === undefined) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [isTerminal, startedAt]);

  if (startedAt === undefined) return null;

  let elapsedMs: number;
  if (isTerminal || hasTerminalSummary) {
    if (frozenElapsedRef.current !== null) {
      elapsedMs = frozenElapsedRef.current;
    } else if (summary?.endedAt && startedAt) {
      elapsedMs = Math.max(0, summary.endedAt - startedAt);
    } else if (summary?.wallClockMs !== undefined) {
      elapsedMs = summary.wallClockMs;
    } else {
      elapsedMs = Math.max(0, Date.now() - startedAt);
    }
  } else {
    elapsedMs = Math.max(0, Date.now() - startedAt);
    if (frozenElapsedRef.current !== null) frozenElapsedRef.current = null;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={
          "text-xs font-mono tabular-nums " +
          (isTerminal ? "text-ink-400" : "text-ink-300")
        }
        title={[
          "Wall-clock elapsed since run_started.",
          `Started: ${new Date(startedAt).toLocaleString()}`,
          isTerminal ? "Frozen at run end." : "Updates every second while running.",
        ].join("\n")}
      >
        {formatRuntime(elapsedMs)}
      </span>
      <ProviderQueueChip />
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