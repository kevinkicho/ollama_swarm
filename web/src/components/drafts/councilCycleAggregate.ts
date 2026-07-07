import type { TranscriptEntry } from "../../types";
import { parseExecutionLine, type ExecutionEvent } from "./councilDraftParse";

export interface CouncilCycleData {
  cycle: number;
  isDrainOnly: boolean;
  rounds: Map<number, Map<number, TranscriptEntry>>;
  execution: ExecutionEvent[];
  conformance: string | null;
  todosDone: number;
  todosFailed: number;
  todosSkipped: number;
  hasCompleteSummary: boolean;
  maxAgentIndex: number;
}

/** Walk transcript in order and build per-cycle draft + execution aggregates for the Drafts tab. */
export function aggregateCouncilCycles(transcript: TranscriptEntry[]): CouncilCycleData[] {
  const out: CouncilCycleData[] = [];
  let current: CouncilCycleData | null = null;

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
        hasCompleteSummary: false,
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
        current.hasCompleteSummary = true;
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
}

export function cycleShowsExecCounts(cycle: CouncilCycleData): boolean {
  const total = cycle.todosDone + cycle.todosFailed + cycle.todosSkipped;
  return cycle.hasCompleteSummary || total > 0;
}