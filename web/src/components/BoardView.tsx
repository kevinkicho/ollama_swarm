import { memo, useMemo, useState } from "react";
import { useSwarm } from "../state/store";
import type { Finding, RunSummary, Todo, TodoStatus } from "../types";

const COLUMNS: { key: TodoStatus; label: string; accent: string; help: string }[] = [
  {
    key: "open",
    label: "Open",
    accent: "border-sky-500/40 text-sky-300",
    help: "Posted by the planner, not yet claimed. Any idle worker can pick one up.",
  },
  {
    key: "claimed",
    label: "Claimed",
    accent: "border-amber-500/40 text-amber-300",
    help: "A worker is holding this todo. File SHAs are recorded for CAS at commit time.",
  },
  {
    key: "committed",
    label: "Committed",
    accent: "border-emerald-500/40 text-emerald-300",
    help: "Diff passed CAS and was written to disk. A git commit is created at the clone root.",
  },
  {
    key: "stale",
    label: "Stale",
    accent: "border-rose-500/40 text-rose-300",
    help:
      "CAS rejected this commit — a file changed underneath the worker. The planner will rewrite and reopen it; the R1/R2 badge counts replans.",
  },
  {
    key: "skipped",
    label: "Skipped",
    accent: "border-ink-500/60 text-ink-300",
    help: "Planner declined to replan this todo (too many rewrites, or no longer meaningful).",
  },
];

export function BoardView() {
  const todos = useSwarm((s) => s.todos);
  const findings = useSwarm((s) => s.findings);
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);
  const summary = useSwarm((s) => s.summary);

  const grouped = useMemo(() => {
    const out: Record<TodoStatus, Todo[]> = {
      open: [],
      claimed: [],
      committed: [],
      stale: [],
      skipped: [],
    };
    for (const t of Object.values(todos)) out[t.status].push(t);
    for (const k of Object.keys(out) as TodoStatus[]) {
      out[k].sort((a, b) => a.createdAt - b.createdAt);
    }
    return out;
  }, [todos]);

  const agentLabel = (agentId: string | undefined): string => {
    if (!agentId) return "—";
    const a = agents[agentId];
    return a ? `Agent ${a.index}` : agentId;
  };

  const hasTodos = Object.values(todos).length > 0;
  const showSummary =
    summary !== undefined &&
    (phase === "completed" || phase === "stopped" || phase === "failed");

  return (
    <div className="h-full overflow-hidden flex flex-col bg-ink-900">
      {showSummary ? <SummaryCard summary={summary} /> : null}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="grid grid-cols-5 min-w-[900px] h-full">
          {COLUMNS.map((col) => (
            <Column
              key={col.key}
              label={col.label}
              accent={col.accent}
              help={col.help}
              count={grouped[col.key].length}
              todos={grouped[col.key]}
              agentLabel={agentLabel}
            />
          ))}
        </div>
        {!hasTodos ? (
          <div className="px-4 py-6 text-sm text-ink-400">
            No todos yet. The planner will post them once the run reaches the planning phase.
          </div>
        ) : null}
      </div>
      <FindingsPane findings={findings} agentLabel={agentLabel} />
    </div>
  );
}

interface ColumnProps {
  label: string;
  accent: string;
  help: string;
  count: number;
  todos: Todo[];
  agentLabel: (agentId: string | undefined) => string;
}

function Column({ label, accent, help, count, todos, agentLabel }: ColumnProps) {
  return (
    <div className="flex flex-col border-r border-ink-700 last:border-r-0 min-h-0">
      <div
        title={help}
        className={`px-3 py-2 border-b ${accent} border-b-ink-700 text-xs uppercase tracking-wide flex items-center justify-between bg-ink-800 cursor-help`}
      >
        <span>{label}</span>
        <span className="text-ink-400">{count}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {todos.map((t) => (
          <TodoCard key={t.id + ":" + t.status} todo={t} agentLabel={agentLabel} />
        ))}
        {todos.length === 0 ? <div className="text-xs text-ink-500 italic p-2">empty</div> : null}
      </div>
    </div>
  );
}

interface TodoCardProps {
  todo: Todo;
  agentLabel: (agentId: string | undefined) => string;
}

const TodoCard = memo(function TodoCard({ todo, agentLabel }: TodoCardProps) {
  const ageMs = todo.claim ? Date.now() - todo.claim.claimedAt : undefined;

  return (
    <div className="rounded-md border border-ink-700 bg-ink-800 p-2 text-xs space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-ink-100 leading-snug">{todo.description}</div>
        {todo.replanCount > 0 ? (
          <span
            className="shrink-0 px-1.5 py-0.5 rounded bg-amber-900/50 border border-amber-700 text-amber-300 text-[10px] uppercase tracking-wide"
            title="Replan count"
          >
            R{todo.replanCount}
          </span>
        ) : null}
      </div>
      {todo.expectedFiles.length > 0 ? (
        <div className="font-mono text-[11px] text-ink-400 break-all">
          {todo.expectedFiles.join(", ")}
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-[10px] text-ink-500">
        <span>by {agentLabel(todo.createdBy)}</span>
        {todo.status === "claimed" && todo.claim ? (
          <>
            <span>·</span>
            <span className="text-amber-300">{agentLabel(todo.claim.agentId)}</span>
            {ageMs !== undefined ? <span>· {formatAge(ageMs)}</span> : null}
          </>
        ) : null}
        {todo.status === "committed" && todo.committedAt ? (
          <>
            <span>·</span>
            <span>{new Date(todo.committedAt).toLocaleTimeString()}</span>
          </>
        ) : null}
      </div>
      {todo.status === "stale" && todo.staleReason ? (
        <div className="rounded border border-rose-900 bg-rose-950/60 px-2 py-1 text-[11px] text-rose-200">
          {todo.staleReason}
        </div>
      ) : null}
      {todo.status === "skipped" && todo.skippedReason ? (
        <div className="rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[11px] text-ink-300">
          {todo.skippedReason}
        </div>
      ) : null}
    </div>
  );
});

function formatAge(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

interface FindingsPaneProps {
  findings: Finding[];
  agentLabel: (agentId: string | undefined) => string;
}

interface SummaryCardProps {
  summary: RunSummary;
}

function SummaryCard({ summary }: SummaryCardProps) {
  const [open, setOpen] = useState(false);
  const accent = stopReasonAccent(summary.stopReason);
  return (
    <div className={`shrink-0 border-b border-ink-700 bg-ink-800 ${accent.border}`}>
      <div className="flex items-start gap-4 px-3 py-2">
        <div className={`shrink-0 text-xs uppercase tracking-wide px-2 py-1 rounded ${accent.badge}`}>
          {summary.stopReason}
        </div>
        <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Stat label="Commits" value={String(summary.commits)} />
          <Stat label="Files changed" value={String(summary.filesChanged)} />
          <Stat label="Stale events" value={String(summary.staleEvents)} />
          <Stat label="Skipped" value={String(summary.skippedTodos)} />
          <Stat label="Total todos" value={String(summary.totalTodos)} />
          <Stat label="Wall clock" value={formatDuration(summary.wallClockMs)} />
          <Stat label="Model" value={summary.model} />
          <Stat label="Preset" value={summary.preset} />
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      {summary.stopDetail ? (
        <div className="px-3 pb-2 -mt-1 text-[11px] italic text-ink-400 leading-snug">
          {summary.stopDetail}
        </div>
      ) : null}
      {open ? (
        <div className="px-3 pb-3 space-y-2 text-xs">
          <div>
            <div className="text-ink-500 mb-1">Agents</div>
            <div className="grid grid-cols-[auto_auto_auto] gap-x-4 gap-y-0.5 w-max">
              {summary.agents.map((a) => (
                <AgentStatRow key={a.agentId} agent={a} />
              ))}
            </div>
          </div>
          <div>
            <div className="text-ink-500 mb-1">
              git status --porcelain
              {summary.finalGitStatusTruncated ? " (truncated)" : ""}
            </div>
            <pre className="rounded border border-ink-700 bg-ink-950 p-2 max-h-48 overflow-auto text-[11px] font-mono text-ink-300 whitespace-pre-wrap">
              {summary.finalGitStatus.length > 0 ? summary.finalGitStatus : "(clean)"}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-ink-500 shrink-0">{label}:</span>
      <span className="text-ink-100 truncate" title={value}>{value}</span>
    </div>
  );
}

function AgentStatRow({
  agent,
}: {
  agent: RunSummary["agents"][number];
}) {
  const tokens =
    agent.tokensIn === null && agent.tokensOut === null
      ? "tokens: —"
      : `tokens: ${agent.tokensIn ?? "?"}/${agent.tokensOut ?? "?"}`;
  return (
    <>
      <span className="text-ink-300">Agent {agent.agentIndex}</span>
      <span className="text-ink-400 font-mono">{agent.turnsTaken} turn(s)</span>
      <span className="text-ink-500">{tokens}</span>
    </>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function stopReasonAccent(reason: RunSummary["stopReason"]): { badge: string; border: string } {
  switch (reason) {
    case "completed":
      return { badge: "bg-emerald-900/60 text-emerald-200", border: "border-l-4 border-l-emerald-500" };
    case "user":
      return { badge: "bg-ink-700 text-ink-200", border: "border-l-4 border-l-ink-400" };
    case "crash":
      return { badge: "bg-rose-900/60 text-rose-200", border: "border-l-4 border-l-rose-500" };
    case "cap:wall-clock":
    case "cap:commits":
    case "cap:todos":
    case "cap:tokens":
      return { badge: "bg-amber-900/60 text-amber-200", border: "border-l-4 border-l-amber-500" };
    case "cap:quota":
      // Task #158: distinct rose styling for the upstream-Ollama-walled
      // case; visually separates "we hit our own cap" from "Ollama walled us".
      return { badge: "bg-rose-900/60 text-rose-200", border: "border-l-4 border-l-rose-500" };
    case "early-stop":
      return { badge: "bg-sky-900/60 text-sky-200", border: "border-l-4 border-l-sky-500" };
  }
}

function FindingsPane({ findings, agentLabel }: FindingsPaneProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-ink-700 bg-ink-800 shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-ink-300 hover:bg-ink-700"
      >
        <span>Findings</span>
        <span className="text-ink-400">
          {findings.length} {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="max-h-56 overflow-y-auto p-2 space-y-2">
          {findings.length === 0 ? (
            <div className="text-xs text-ink-500 italic p-1">No findings yet.</div>
          ) : (
            findings.map((f) => (
              <div
                key={f.id}
                className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2 text-[10px] text-ink-500 mb-0.5">
                  <span>{agentLabel(f.agentId)}</span>
                  <span>·</span>
                  <span>{new Date(f.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="whitespace-pre-wrap text-ink-200">{f.text}</div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
