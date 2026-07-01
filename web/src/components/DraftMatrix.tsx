import { useMemo, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry } from "../types";

export function DraftMatrix() {
  const transcript = useSwarm((s) => s.transcript);
  const cfg = useSwarm((s) => s.runConfig);
  const agentCount = cfg?.agentCount ?? 0;
  const [expanded, setExpanded] = useState<string | null>(null);

  // Parse transcript into cycles: each cycle starts with a "═══ Council cycle N ═══" or
  // "═══ Council cycle N — completing unfinished work ═══" system message.
  const cycles = useMemo(() => {
    const out: Array<{
      cycle: number;
      rounds: Map<number, Map<number, TranscriptEntry>>;
      execution: TranscriptEntry[];
      conformance: string | null;
      todosDone: number;
      todosFailed: number;
      todosSkipped: number;
    }> = [];
    let current: (typeof out)[number] | null = null;

    for (const e of transcript) {
      const text = e.text ?? "";
      const cycleMatch = text.match(/═══ Council cycle (\d+)/);
      if (cycleMatch) {
        if (current) out.push(current);
        current = {
          cycle: Number.parseInt(cycleMatch[1], 10),
          rounds: new Map(),
          execution: [],
          conformance: null,
          todosDone: 0,
          todosFailed: 0,
          todosSkipped: 0,
        };
      }
      if (!current) continue;

      // Draft entries
      if (e.role === "agent" && e.summary?.kind === "council_draft") {
        const r = e.summary.round;
        if (!current.rounds.has(r)) current.rounds.set(r, new Map());
        current.rounds.get(r)!.set(e.agentIndex ?? 0, e);
      }

      // Execution results
      if (e.role === "system") {
        if (text.includes("✓ applied")) current.todosDone++;
        else if (text.includes("✗ apply failed")) current.todosFailed++;
        else if (text.includes("skipped:")) current.todosSkipped++;
        if (text.startsWith("[conformance]")) current.conformance = text;
        if (text.startsWith("[execution]") && (text.includes("✓") || text.includes("skipped") || text.includes("✗"))) {
          current.execution.push(e);
        }
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
    <div className="h-full overflow-auto p-4 space-y-6">
      {cycles.map((cycle) => {
        const rounds = Array.from(cycle.rounds.keys()).sort((a, b) => a - b);
        const totalTodos = cycle.todosDone + cycle.todosFailed + cycle.todosSkipped;
        return (
          <div key={cycle.cycle} className="border border-ink-700 rounded-md p-3">
            {/* Cycle header */}
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-ink-200">
                Cycle {cycle.cycle}
              </div>
              <div className="flex gap-3 text-[10px]">
                {totalTodos > 0 ? (
                  <>
                    <span className="text-emerald-400">{cycle.todosDone} done</span>
                    <span className="text-amber-400">{cycle.todosSkipped} skipped</span>
                    {cycle.todosFailed > 0 ? (
                      <span className="text-rose-400">{cycle.todosFailed} failed</span>
                    ) : null}
                  </>
                ) : null}
                {cycle.conformance ? (
                  <span className="text-ink-400">{cycle.conformance.match(/Score: (\d+\/100)/)?.[1] ?? ""}</span>
                ) : null}
              </div>
            </div>

            {/* Draft rounds grid */}
            {rounds.length > 0 ? (
              <div className="space-y-2">
                {rounds.map((r) => {
                  const row = cycle.rounds.get(r)!;
                  const phaseLabel = r === 1 ? "DRAFT" : "REVEAL";
                  return (
                    <div key={r}>
                      <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-1">
                        Round {r} · {phaseLabel}
                      </div>
                      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(agentCount, 1)}, minmax(0, 1fr))` }}>
                        {Array.from({ length: agentCount }, (_, i) => {
                          const idx = i + 1;
                          const entry = row.get(idx);
                          const cellKey = `c${cycle.cycle}-r${r}-a${idx}`;
                          const isExpanded = expanded === cellKey;
                          const text = entry?.text ?? "";
                          const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
                          return (
                            <button
                              key={cellKey}
                              onClick={() => setExpanded(isExpanded ? null : cellKey)}
                              className={`text-left text-xs border rounded p-1.5 transition ${
                                entry
                                  ? "border-ink-700 bg-ink-800/60 hover:bg-ink-800 hover:border-ink-600"
                                  : "border-ink-800 bg-ink-900/40 text-ink-600"
                              }`}
                            >
                              <div className="text-[10px] uppercase tracking-wide text-ink-500 mb-0.5">
                                Agent {idx}
                                {entry ? ` · ${new Date(entry.ts).toLocaleTimeString()}` : ""}
                              </div>
                              {entry ? (
                                <div className="whitespace-pre-wrap text-ink-300 leading-snug">
                                  {isExpanded ? text : preview}
                                </div>
                              ) : (
                                <div className="italic">— no entry —</div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-ink-500 italic">No discussion rounds — execution-only cycle</div>
            )}

            {/* Execution results */}
            {cycle.execution.length > 0 ? (
              <div className="mt-2 space-y-0.5">
                <div className="text-[10px] uppercase tracking-wider text-ink-500">Execution</div>
                {cycle.execution.map((e) => {
                  const text = e.text ?? "";
                  const isDone = text.includes("✓");
                  const isSkipped = text.includes("skipped");
                  const isFail = text.includes("✗");
                  const icon = isDone ? "✓" : isSkipped ? "⏭" : isFail ? "✗" : "·";
                  const color = isDone ? "text-emerald-400" : isSkipped ? "text-amber-400" : isFail ? "text-rose-400" : "text-ink-400";
                  return (
                    <div key={e.id} className={`text-xs ${color} truncate`}>
                      <span className="font-mono mr-1">{icon}</span>
                      {text.replace(/^\[execution\] /, "").slice(0, 120)}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
