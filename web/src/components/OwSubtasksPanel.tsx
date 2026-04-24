import { useMemo } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry } from "../types";

// Phase 2e (2026-04-24): orchestrator-worker specific view. Reads
// existing transcript entries; no new server-side data. Groups by
// assignment wave (each orchestrator "assignments" envelope starts a
// new wave; the next few worker responses are the assigned subtasks;
// the next orchestrator response is the synthesis).
//
// Relies on task #43's summary.kind === "ow_assignments" to identify
// assignment waves. Worker responses are assumed to be agent-N-indexed
// entries between the assignments envelope and the next orchestrator
// response.
interface Wave {
  assignments: TranscriptEntry;
  workerResponses: Map<number, TranscriptEntry>;
  synthesis?: TranscriptEntry;
}

export function OwSubtasksPanel() {
  const transcript = useSwarm((s) => s.transcript);

  const waves = useMemo(() => {
    const out: Wave[] = [];
    let current: Wave | null = null;
    for (const e of transcript) {
      if (e.role !== "agent") continue;
      if (e.agentIndex === 1 && e.summary?.kind === "ow_assignments") {
        // Start a new wave on every orchestrator assignments envelope.
        if (current) out.push(current);
        current = { assignments: e, workerResponses: new Map() };
        continue;
      }
      if (!current) continue;
      if (e.agentIndex === 1) {
        // Orchestrator response that ISN'T an assignments envelope =
        // the synthesis step for the current wave.
        current.synthesis = e;
        out.push(current);
        current = null;
        continue;
      }
      if (e.agentIndex !== undefined && e.agentIndex > 1) {
        // Worker response. Capture in the current wave.
        current.workerResponses.set(e.agentIndex, e);
      }
    }
    if (current) out.push(current);
    return out;
  }, [transcript]);

  if (waves.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No orchestrator assignments yet. The lead (agent-1) emits a JSON
        assignments envelope each round; workers execute in parallel and the
        lead synthesizes at the end.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 text-sm">
      {waves.map((wave, i) => {
        const assignments =
          wave.assignments.summary?.kind === "ow_assignments"
            ? wave.assignments.summary.assignments
            : [];
        return (
          <div key={wave.assignments.id} className="mb-6">
            <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">
              Wave {i + 1} · {new Date(wave.assignments.ts).toLocaleTimeString()} ·{" "}
              {assignments.length} subtask{assignments.length === 1 ? "" : "s"}
            </div>
            <div className="space-y-2">
              {assignments.map((a) => {
                const response = wave.workerResponses.get(a.agentIndex);
                return (
                  <div
                    key={`${wave.assignments.id}-${a.agentIndex}`}
                    className="border border-ink-700 rounded p-3 bg-ink-800/40"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-amber-300 mb-1">
                      → agent-{a.agentIndex}
                      {response ? ` · completed at ${new Date(response.ts).toLocaleTimeString()}` : " · pending"}
                    </div>
                    <div className="text-xs text-ink-300 mb-2 italic">{a.subtask}</div>
                    {response ? (
                      <div className="text-xs text-ink-400 whitespace-pre-wrap leading-snug border-l border-ink-700 pl-3">
                        {response.text.length > 500
                          ? response.text.slice(0, 500) + "…"
                          : response.text}
                      </div>
                    ) : (
                      <div className="text-xs text-ink-500 italic">
                        Waiting for worker response…
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {wave.synthesis ? (
              <div className="mt-3 border border-amber-700 bg-amber-950/20 rounded p-3">
                <div className="text-[10px] uppercase tracking-wider text-amber-300 mb-1">
                  Orchestrator synthesis · {new Date(wave.synthesis.ts).toLocaleTimeString()}
                </div>
                <div className="whitespace-pre-wrap text-ink-200 text-xs leading-snug">
                  {wave.synthesis.text}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="mt-6 text-xs text-ink-500">
        <p>
          Reading this view: each wave = one round of the orchestrator-worker cycle.
          Orchestrator assigns subtasks → workers execute in parallel → orchestrator
          synthesizes. The amber-bordered synthesis block closes each wave.
        </p>
      </div>
    </div>
  );
}
