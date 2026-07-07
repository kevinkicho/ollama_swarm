import { useMemo, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry } from "../types";
import {
  parseCouncilIssues,
  parseExecutionLine,
  type ExecutionEvent,
} from "./drafts/councilDraftParse";
import { CouncilIssueList } from "./drafts/CouncilIssueList";

interface CycleData {
  cycle: number;
  isDrainOnly: boolean;
  rounds: Map<number, Map<number, TranscriptEntry>>;
  execution: ExecutionEvent[];
  conformance: string | null;
  todosDone: number;
  todosFailed: number;
  todosSkipped: number;
  maxAgentIndex: number;
}

function executionStatusClass(status: ExecutionEvent["status"]): string {
  switch (status) {
    case "done":
      return "text-emerald-400";
    case "skipped":
      return "text-amber-400";
    case "failed":
      return "text-rose-400";
    case "working":
      return "text-sky-400";
    case "summary":
      return "text-ink-300 font-medium";
    default:
      return "text-ink-400";
  }
}

function executionIcon(status: ExecutionEvent["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "skipped":
      return "⏭";
    case "failed":
      return "✗";
    case "working":
      return "◎";
    case "summary":
      return "∑";
    default:
      return "·";
  }
}

function DraftCell({
  entry,
  agentIndex,
  expanded,
  onToggleCell,
  issuesExpanded,
  onToggleIssues,
}: {
  entry: TranscriptEntry | undefined;
  agentIndex: number;
  expanded: boolean;
  onToggleCell: () => void;
  issuesExpanded: boolean;
  onToggleIssues: () => void;
}) {
  const text = entry?.text ?? "";
  const issues = useMemo(() => (text ? parseCouncilIssues(text) : null), [text]);
  const phase = entry?.summary?.kind === "council_draft" ? entry.summary.phase : null;

  return (
    <div
      className={`flex flex-col min-h-[7rem] rounded-md border p-2 transition ${
        entry
          ? "border-ink-700 bg-ink-800/50 hover:border-ink-600"
          : "border-ink-800/80 bg-ink-900/30"
      }`}
    >
      <button
        type="button"
        onClick={onToggleCell}
        className="text-left w-full shrink-0"
      >
        <div className="flex items-center justify-between gap-1 mb-1">
          <span className="text-[11px] font-semibold text-ink-200">Agent {agentIndex}</span>
          {phase ? (
            <span
              className={`text-[9px] uppercase tracking-wider px-1 rounded ${
                phase === "draft" ? "text-sky-300 bg-sky-950/40" : "text-emerald-300 bg-emerald-950/40"
              }`}
            >
              {phase}
            </span>
          ) : null}
        </div>
        {entry ? (
          <div className="text-[9px] text-ink-500">
            {new Date(entry.ts).toLocaleTimeString()}
            {issues ? ` · ${issues.length} issue${issues.length === 1 ? "" : "s"}` : ""}
          </div>
        ) : (
          <div className="text-[10px] italic text-ink-600">No draft</div>
        )}
      </button>

      {entry && issues ? (
        <div className="mt-1.5 flex-1 overflow-hidden">
          <CouncilIssueList
            issues={issues}
            expanded={issuesExpanded}
            onToggle={onToggleIssues}
          />
        </div>
      ) : entry ? (
        <button
          type="button"
          onClick={onToggleCell}
          className="mt-1.5 text-left flex-1"
        >
          <p className={`text-[11px] text-ink-300 leading-snug whitespace-pre-wrap ${expanded ? "" : "line-clamp-6"}`}>
            {text}
          </p>
          {text.length > 280 && !expanded ? (
            <span className="text-[10px] text-ink-500 underline">Show full text</span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}

export function DraftMatrix() {
  const transcript = useSwarm((s) => s.transcript);
  const cfg = useSwarm((s) => s.runConfig);
  const configuredAgents = cfg?.agentCount ?? 0;
  const [expandedCell, setExpandedCell] = useState<string | null>(null);
  const [expandedIssues, setExpandedIssues] = useState<Set<string>>(new Set());
  const [collapsedCycles, setCollapsedCycles] = useState<Set<number>>(new Set());

  const cycles = useMemo(() => {
    const out: CycleData[] = [];
    let current: CycleData | null = null;

    for (const e of transcript) {
      const text = e.text ?? "";
      const cycleMatch = text.match(/═══ Council cycle (\d+)/);
      if (cycleMatch) {
        if (current) out.push(current);
        current = {
          cycle: Number.parseInt(cycleMatch[1], 10),
          isDrainOnly: /draining/i.test(text),
          rounds: new Map(),
          execution: [],
          conformance: null,
          todosDone: 0,
          todosFailed: 0,
          todosSkipped: 0,
          maxAgentIndex: 0,
        };
      }
      if (!current) continue;

      if (e.role === "agent" && e.summary?.kind === "council_draft") {
        const r = e.summary.round;
        const idx = e.agentIndex ?? 0;
        if (idx > current.maxAgentIndex) current.maxAgentIndex = idx;
        if (!current.rounds.has(r)) current.rounds.set(r, new Map());
        current.rounds.get(r)!.set(idx, e);
      }

      if (e.role === "system" && text.startsWith("[execution]")) {
        const ev = parseExecutionLine(text);
        current.execution.push(ev);
        if (ev.status === "summary") {
          const m = ev.detail.match(/(\d+) done · (\d+) failed · (\d+) skipped/);
          if (m) {
            current.todosDone = Number.parseInt(m[1], 10);
            current.todosFailed = Number.parseInt(m[2], 10);
            current.todosSkipped = Number.parseInt(m[3], 10);
          }
        } else if (ev.status === "done") current.todosDone++;
        else if (ev.status === "failed") current.todosFailed++;
        else if (ev.status === "skipped") current.todosSkipped++;
      }

      if (e.role === "system" && text.startsWith("[conformance]")) {
        current.conformance = text;
      }
    }
    if (current) out.push(current);
    return out;
  }, [transcript]);

  if (cycles.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No council cycles yet. Drafts populate as agents complete their first parallel turn.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {cycles.map((cycle) => {
        const rounds = Array.from(cycle.rounds.keys()).sort((a, b) => a - b);
        const agentSlots = Math.max(configuredAgents, cycle.maxAgentIndex, 1);
        const collapsed = collapsedCycles.has(cycle.cycle);
        const hasDiscussion = rounds.length > 0;
        const totalTodos = cycle.todosDone + cycle.todosFailed + cycle.todosSkipped;

        return (
          <section
            key={cycle.cycle}
            className="rounded-lg border border-ink-700/90 bg-ink-900/30 overflow-hidden"
          >
            <button
              type="button"
              onClick={() =>
                setCollapsedCycles((prev) => {
                  const next = new Set(prev);
                  if (next.has(cycle.cycle)) next.delete(cycle.cycle);
                  else next.add(cycle.cycle);
                  return next;
                })
              }
              className="w-full flex items-center justify-between gap-3 px-3 py-2.5 bg-ink-800/40 hover:bg-ink-800/60 transition text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-ink-100 shrink-0">
                  Cycle {cycle.cycle}
                </span>
                {hasDiscussion ? (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-950/50 text-sky-300 border border-sky-900/50">
                    {rounds.length} discussion round{rounds.length === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300/90 border border-amber-900/40">
                    Execution only
                  </span>
                )}
                {cycle.isDrainOnly ? (
                  <span className="text-[10px] text-ink-500 truncate hidden sm:inline">
                    Draining todo queue
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3 shrink-0 text-[10px]">
                {totalTodos > 0 ? (
                  <>
                    <span className="text-emerald-400">{cycle.todosDone} done</span>
                    <span className="text-amber-400">{cycle.todosSkipped} skip</span>
                    {cycle.todosFailed > 0 ? (
                      <span className="text-rose-400">{cycle.todosFailed} fail</span>
                    ) : null}
                  </>
                ) : null}
                {cycle.conformance ? (
                  <span className="text-ink-400">
                    {cycle.conformance.match(/Score: (\d+\/100)/)?.[1] ?? ""}
                  </span>
                ) : null}
                <span className="text-ink-500">{collapsed ? "▸" : "▾"}</span>
              </div>
            </button>

            {!collapsed ? (
              <div className="p-3 space-y-4">
                {hasDiscussion ? (
                  <div className="space-y-3">
                    {rounds.map((r) => {
                      const row = cycle.rounds.get(r)!;
                      const phaseLabel = r === 1 ? "Independent draft" : "Reveal & revise";
                      return (
                        <div key={r}>
                          <div className="flex items-baseline gap-2 mb-2">
                            <h4 className="text-xs font-semibold text-ink-200">
                              Round {r}
                            </h4>
                            <span className="text-[10px] uppercase tracking-wider text-ink-500">
                              {phaseLabel}
                            </span>
                          </div>
                          <div
                            className="grid gap-2"
                            style={{
                              gridTemplateColumns: `repeat(${Math.min(agentSlots, 4)}, minmax(0, 1fr))`,
                            }}
                          >
                            {Array.from({ length: agentSlots }, (_, i) => {
                              const idx = i + 1;
                              const entry = row.get(idx);
                              const cellKey = `c${cycle.cycle}-r${r}-a${idx}`;
                              return (
                                <DraftCell
                                  key={cellKey}
                                  entry={entry}
                                  agentIndex={idx}
                                  expanded={expandedCell === cellKey}
                                  onToggleCell={() =>
                                    setExpandedCell((k) => (k === cellKey ? null : cellKey))
                                  }
                                  issuesExpanded={expandedIssues.has(cellKey)}
                                  onToggleIssues={() =>
                                    setExpandedIssues((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(cellKey)) next.delete(cellKey);
                                      else next.add(cellKey);
                                      return next;
                                    })
                                  }
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-ink-400 leading-relaxed rounded border border-ink-800 bg-ink-950/30 px-3 py-2">
                    This cycle skipped discussion because pending todos were queued from the prior
                    audit. Workers executed (or skipped) those todos below.
                  </p>
                )}

                {cycle.execution.length > 0 ? (
                  <div className="border-t border-ink-800 pt-3">
                    <h4 className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">
                      Execution
                    </h4>
                    <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                      {cycle.execution.map((ev, i) => (
                        <li
                          key={`${cycle.cycle}-ex-${i}`}
                          className={`text-xs leading-snug flex gap-1.5 ${executionStatusClass(ev.status)}`}
                        >
                          <span className="font-mono shrink-0 w-3 text-center">
                            {executionIcon(ev.status)}
                          </span>
                          <span className="min-w-0">
                            {ev.agentId ? (
                              <span className="font-mono text-ink-500 mr-1">{ev.agentId}</span>
                            ) : null}
                            <span className="break-words">{ev.detail}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}