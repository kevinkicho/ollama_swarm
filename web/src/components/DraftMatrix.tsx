import { useMemo, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry } from "../types";

// Phase 2b (2026-04-24): council-specific 2D grid view.
//   rows = rounds (1 = independent DRAFT, 2+ = REVISE/REVEAL)
//   cols = agents
//   cells = that agent's contribution that round
//
// Reads transcript entries tagged by CouncilRunner with a
// summary.kind === "council_draft" carrying { round, phase }.
// Untagged entries (system messages, run-start dividers, agents
// from other presets if the user is mid-switch) are ignored.
export function DraftMatrix() {
  const transcript = useSwarm((s) => s.transcript);
  const cfg = useSwarm((s) => s.runConfig);
  const agentCount = cfg?.agentCount ?? 0;
  const [expanded, setExpanded] = useState<string | null>(null);

  // Bucket entries into matrix[round][agentIndex - 1].
  const matrix = useMemo(() => {
    const buckets = new Map<number, Map<number, TranscriptEntry>>();
    for (const e of transcript) {
      if (e.role !== "agent") continue;
      if (!e.summary || e.summary.kind !== "council_draft") continue;
      const r = e.summary.round;
      if (!buckets.has(r)) buckets.set(r, new Map());
      buckets.get(r)!.set(e.agentIndex ?? 0, e);
    }
    return buckets;
  }, [transcript]);

  const rounds = Array.from(matrix.keys()).sort((a, b) => a - b);

  if (rounds.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No council drafts yet. Round 1 drafts populate as agents complete their first parallel turn.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs text-ink-500 mb-3">
        Council drafts · {rounds.length} round{rounds.length === 1 ? "" : "s"} · {agentCount} agent
        {agentCount === 1 ? "" : "s"} · Round 1 = independent (peer-hidden); Round 2+ = revisions
        after seeing other drafts. Click any cell to expand.
      </div>
      {rounds.map((r) => {
        const row = matrix.get(r)!;
        const phase = row.values().next().value?.summary?.kind === "council_draft"
          ? row.values().next().value!.summary
          : undefined;
        const phaseLabel =
          phase?.kind === "council_draft" && phase.phase === "draft"
            ? "DRAFT"
            : "REVEAL";
        return (
          <div key={r} className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-1">
              Round {r} · {phaseLabel}
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(agentCount, 1)}, minmax(0, 1fr))` }}>
              {Array.from({ length: agentCount }, (_, i) => {
                const idx = i + 1;
                const entry = row.get(idx);
                const cellKey = `r${r}-a${idx}`;
                const isExpanded = expanded === cellKey;
                const text = entry?.text ?? "";
                const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
                return (
                  <button
                    key={cellKey}
                    onClick={() => setExpanded(isExpanded ? null : cellKey)}
                    className={`text-left text-xs border rounded p-2 transition ${
                      entry
                        ? "border-ink-700 bg-ink-800/60 hover:bg-ink-800 hover:border-ink-600"
                        : "border-ink-800 bg-ink-900/40 text-ink-600"
                    }`}
                  >
                    <div className="text-[10px] uppercase tracking-wide text-ink-500 mb-1">
                      Agent {idx}
                      {entry ? ` · ${new Date(entry.ts).toLocaleTimeString()}` : ""}
                    </div>
                    {entry ? (
                      <div className="whitespace-pre-wrap text-ink-300 leading-snug">
                        {isExpanded ? text : preview}
                      </div>
                    ) : (
                      <div className="italic">— no entry yet —</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="mt-6 text-xs text-ink-500">
        <p>
          Reading this view: round 1 cells should be GENUINELY different from each other (the
          peer-hidden prompt enforces independence). Round 2+ cells should explicitly reference
          other drafts ("I agree with agent 3 that…"). If round 2+ doesn't reflect peer content,
          the reveal-prompt isn't doing its job.
        </p>
      </div>
    </div>
  );
}
