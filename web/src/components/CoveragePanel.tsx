import { useMemo } from "react";
import { useSwarm } from "../state/store";

// Phase 2d (2026-04-24): map-reduce coverage map. Shows which mapper
// was assigned which slice of top-level repo entries. Read from the
// store.mapperSlices map populated by the mapper_slices WS event +
// REST catch-up.
//
// Rendering layout: one row per top-level entry, with colored chips
// marking the mapper(s) assigned to it. Normally each slice is
// disjoint (round-robin slicing) so there's exactly one chip per
// row, but the component tolerates overlap defensively.
const AGENT_HUE = [140, 200, 260, 30, 320, 70, 180, 240];

export function CoveragePanel() {
  const slices = useSwarm((s) => s.mapperSlices);
  const agents = useSwarm((s) => s.agents);

  const { tree, orderedAgents } = useMemo(() => {
    // Invert the agentId → slice map into entry → agentId[].
    const entryToAgents = new Map<string, string[]>();
    for (const [agentId, entries] of Object.entries(slices)) {
      for (const e of entries) {
        if (!entryToAgents.has(e)) entryToAgents.set(e, []);
        entryToAgents.get(e)!.push(agentId);
      }
    }
    const ordered = Object.keys(slices).sort((a, b) => {
      const ai = agents[a]?.index ?? 99;
      const bi = agents[b]?.index ?? 99;
      return ai - bi;
    });
    const sortedEntries = Array.from(entryToAgents.keys()).sort();
    return {
      tree: sortedEntries.map((entry) => ({
        entry,
        assignedTo: entryToAgents.get(entry) ?? [],
      })),
      orderedAgents: ordered,
    };
  }, [slices, agents]);

  if (tree.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No slice assignments yet. Map-reduce slices repo entries across mappers once the run
        transitions out of cloning. The reducer (agent-1) is excluded — it sees everything via
        the full transcript.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs text-ink-500 mb-3">
        Coverage map · {tree.length} top-level {tree.length === 1 ? "entry" : "entries"} sliced
        across {orderedAgents.length} mapper{orderedAgents.length === 1 ? "" : "s"} · round-robin
        distribution.
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 mb-3">
        {orderedAgents.map((agentId) => {
          const a = agents[agentId];
          const idx = a?.index ?? 0;
          const count = slices[agentId]?.length ?? 0;
          return (
            <span
              key={agentId}
              className="inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full border"
              style={{
                borderColor: `hsl(${AGENT_HUE[(idx - 1) % AGENT_HUE.length]} 40% 35%)`,
                color: `hsl(${AGENT_HUE[(idx - 1) % AGENT_HUE.length]} 60% 70%)`,
              }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: `hsl(${AGENT_HUE[(idx - 1) % AGENT_HUE.length]} 60% 60%)` }}
              />
              agent-{idx} · {count} {count === 1 ? "entry" : "entries"}
            </span>
          );
        })}
      </div>

      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left text-ink-500 uppercase tracking-wide text-[10px] border-b border-ink-700">
            <th className="py-1 px-2">Top-level entry</th>
            <th className="py-1 px-2">Assigned to</th>
          </tr>
        </thead>
        <tbody>
          {tree.map((row) => (
            <tr key={row.entry} className="border-b border-ink-800/60">
              <td className="py-1 px-2 text-ink-200">{row.entry}</td>
              <td className="py-1 px-2">
                <div className="flex flex-wrap gap-1">
                  {row.assignedTo.map((agentId) => {
                    const a = agents[agentId];
                    const idx = a?.index ?? 0;
                    const hue = AGENT_HUE[(idx - 1) % AGENT_HUE.length];
                    return (
                      <span
                        key={agentId}
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          borderWidth: "1px",
                          borderColor: `hsl(${hue} 40% 35%)`,
                          color: `hsl(${hue} 60% 70%)`,
                        }}
                      >
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{ background: `hsl(${hue} 60% 60%)` }}
                        />
                        agent-{idx}
                      </span>
                    );
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6 text-xs text-ink-500">
        <p>
          Reading this view: round-robin slicing should produce a relatively even distribution —
          if one mapper got significantly more entries than the others, check the top-level entry
          count vs mapper count for alignment. Watch the transcript for each mapper's findings per
          cycle.
        </p>
      </div>
    </div>
  );
}
