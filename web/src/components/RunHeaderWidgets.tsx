import { useEffect, useRef, useState } from "react";
import { useSwarm } from "../state/store";

// Unit 52b: composite phase signal for the topbar.
export function PhasePill() {
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

  const agentList = Object.values(agents);
  const aliveAgents = agentList.filter((a) => a.status !== "stopped" && a.status !== "failed").length;
  const thinkingAgents = agentList.filter((a) => a.status === "thinking").length;

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
    case "failed": {
      const finalCommits = summary?.commits ?? counts.committed;
      if (finalCommits > 0) suffix = ` · ${finalCommits} commits`;
      break;
    }
  }

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
      title="Waiting for shared provider capacity"
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
  const isTerminal = hasTerminalSummary || phase === "completed" || phase === "stopped" || phase === "failed";
  const [, setTick] = useState(0);

  // Capture a frozen elapsed value the first time we become terminal, so it doesn't
  // keep advancing on re-renders (even without the setInterval).
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
      // Prefer real startedAt (from run event in store) + summary's endedAt for accurate fixed duration.
      elapsedMs = Math.max(0, summary.endedAt - startedAt);
    } else if (summary?.wallClockMs !== undefined) {
      elapsedMs = summary.wallClockMs;
    } else {
      elapsedMs = Math.max(0, Date.now() - startedAt);
    }
  } else {
    elapsedMs = Math.max(0, Date.now() - startedAt);
    // reset freeze if somehow becomes non-terminal again
    if (frozenElapsedRef.current !== null) frozenElapsedRef.current = null;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={
          "text-xs font-mono tabular-nums " +
          (isTerminal ? "text-ink-400" : "text-ink-300")
        }
        title={`Run started ${new Date(startedAt).toLocaleString()}`}
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