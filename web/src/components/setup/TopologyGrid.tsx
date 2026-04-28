// Phase 1c of the topology refactor (#243): grid that replaces the
// `Agents` number input. Rows are agent specs; +/− scale the count;
// structural rows (planner/auditor/orchestrator/judge…) lock their
// `−` button so users can't accidentally delete the role the preset
// requires. The grid is the source of truth — SetupForm reads its
// `topology` state and POSTs it to /api/swarm/start.
//
// What's NOT here in Phase 1:
//   - per-agent prompt addendum / temperature / tag / color (Phase 2)
//   - saved-topology library (Phase 3)
//   - mirroring into AgentPanel + History (Phase 4)
// Each later phase adds columns or adjacent UI without restructuring.

import {
  type AgentRole,
  type AgentSpec,
  type Topology,
  defaultRoleForIndex,
  isRoleStructural,
  synthesizeTopology,
} from "../../../../shared/src/topology";

interface TopologyGridProps {
  preset: {
    id: string;
    min: number;
    max: number;
  };
  topology: Topology;
  setTopology: (t: Topology) => void;
  // Top-level default model — used as placeholder for per-row Model
  // inputs so the user sees what each agent will fall back to.
  defaultModel: string;
}

// Roles that CAN be added incrementally (the user can add another one
// of these). Today this is just "worker" for blackboard, "mapper" for
// map-reduce, "drafter" for council, "explorer" for stigmergy,
// "peer" for round-robin. Other roles are structural (planner, judge,
// reducer, orchestrator) and the preset's defaults always include the
// right number — never user-added.
function nextAddableRole(preset: string): AgentRole | null {
  switch (preset) {
    case "blackboard":
      return "worker";
    case "map-reduce":
      return "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "orchestrator-worker":
    case "orchestrator-worker-deep":
      return "worker";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      // Fixed at 3 — never addable.
      return null;
    default:
      return "worker";
  }
}

const ROLE_CHIP_STYLES: Record<AgentRole, string> = {
  planner: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  auditor: "bg-violet-900/40 border-violet-700/50 text-violet-200",
  orchestrator: "bg-amber-900/40 border-amber-700/50 text-amber-200",
  "mid-lead": "bg-amber-950/60 border-amber-600/60 text-amber-100",
  reducer: "bg-violet-900/40 border-violet-700/50 text-violet-200",
  judge: "bg-rose-900/40 border-rose-700/50 text-rose-200",
  pro: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  con: "bg-rose-900/40 border-rose-700/50 text-rose-200",
  worker: "bg-ink-700 border-ink-600 text-ink-200",
  mapper: "bg-violet-900/30 border-violet-700/40 text-violet-200",
  drafter: "bg-sky-900/40 border-sky-700/50 text-sky-200",
  explorer: "bg-teal-900/40 border-teal-700/50 text-teal-200",
  peer: "bg-ink-700 border-ink-600 text-ink-300",
  "role-diff": "bg-fuchsia-900/40 border-fuchsia-700/50 text-fuchsia-200",
};

function RoleChip({ role, structural }: { role: AgentRole; structural: boolean }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${ROLE_CHIP_STYLES[role]}`}
      title={structural ? "Structural — required by this preset" : "Flexible — you can scale this role"}
    >
      {structural ? "🔒 " : ""}{role}
    </span>
  );
}

export function TopologyGrid({ preset, topology, setTopology, defaultModel }: TopologyGridProps) {
  const total = topology.agents.length;
  const atMax = total >= preset.max;
  const atMin = total <= preset.min;
  const addableRole = nextAddableRole(preset.id);
  const canAdd = !atMax && addableRole !== null;

  const renumber = (agents: AgentSpec[]): AgentSpec[] => {
    // After +/-, re-derive role + index for every row so the auditor
    // stays at the bottom (blackboard) and mid-lead/worker boundaries
    // shift correctly (orchestrator-worker-deep) when count changes.
    const totalAfter = agents.length;
    return agents.map((_a, i) => {
      const idx = i + 1;
      const role = defaultRoleForIndex(preset.id, idx, totalAfter);
      // Preserve the user's per-row model if they set one and the role
      // hasn't changed; otherwise reset to undefined (falls back to
      // top-level defaultModel).
      const prior = i < agents.length ? agents[i] : undefined;
      const keptModel = prior && prior.role === role ? prior.model : undefined;
      return {
        index: idx,
        role,
        model: keptModel,
        removable: !isRoleStructural(preset.id, role),
      };
    });
  };

  const onAdd = () => {
    if (!canAdd || addableRole === null) return;
    // Insert before the auditor row for blackboard (auditor stays at
    // the bottom). For other presets the new row goes at the end.
    let nextAgents: AgentSpec[];
    if (preset.id === "blackboard") {
      const auditorIdx = topology.agents.findIndex((a) => a.role === "auditor");
      const insertAt = auditorIdx >= 0 ? auditorIdx : topology.agents.length;
      nextAgents = [
        ...topology.agents.slice(0, insertAt),
        { index: insertAt + 1, role: addableRole, removable: true },
        ...topology.agents.slice(insertAt),
      ];
    } else {
      nextAgents = [
        ...topology.agents,
        { index: total + 1, role: addableRole, removable: true },
      ];
    }
    setTopology({ agents: renumber(nextAgents) });
  };

  const onRemove = (index: number) => {
    if (atMin) return;
    const agent = topology.agents.find((a) => a.index === index);
    if (!agent || !agent.removable) return;
    const nextAgents = topology.agents.filter((a) => a.index !== index);
    setTopology({ agents: renumber(nextAgents) });
  };

  const onModelChange = (index: number, value: string) => {
    const trimmed = value.trim();
    setTopology({
      agents: topology.agents.map((a) =>
        a.index === index
          ? { ...a, model: trimmed.length > 0 ? trimmed : undefined }
          : a,
      ),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-ink-400">
          Topology
          <span className="ml-2 text-ink-500 normal-case">
            {total} {total === 1 ? "agent" : "agents"} · min {preset.min} · max {preset.max}
          </span>
        </div>
        {preset.min === preset.max ? (
          <span className="text-[10px] text-ink-500 italic">Fixed for this preset</span>
        ) : null}
      </div>
      <div className="rounded border border-ink-700 bg-ink-900/60 overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="bg-ink-800/60 text-[10px] uppercase tracking-wider text-ink-500">
            <tr>
              <th className="px-2 py-1.5 text-left w-10">#</th>
              <th className="px-2 py-1.5 text-left">Role</th>
              <th className="px-2 py-1.5 text-left">Model override</th>
              <th className="px-2 py-1.5 text-right w-12">Action</th>
            </tr>
          </thead>
          <tbody>
            {topology.agents.map((a) => (
              <tr key={a.index} className="border-t border-ink-800/60">
                <td className="px-2 py-1.5 text-ink-400 font-mono">{a.index}</td>
                <td className="px-2 py-1.5">
                  <RoleChip role={a.role} structural={!a.removable} />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={a.model ?? ""}
                    onChange={(e) => onModelChange(a.index, e.target.value)}
                    placeholder={defaultModel || "(use default)"}
                    className="w-full bg-ink-950/60 border border-ink-700 rounded px-2 py-0.5 text-[11px] font-mono text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  {a.removable && !atMin ? (
                    <button
                      type="button"
                      onClick={() => onRemove(a.index)}
                      title={`Remove agent #${a.index}`}
                      className="w-6 h-6 rounded text-ink-400 hover:text-rose-300 hover:bg-rose-950/40 border border-transparent hover:border-rose-800/50 transition"
                    >
                      −
                    </button>
                  ) : (
                    <span className="w-6 h-6 inline-block" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {canAdd ? (
            <tfoot>
              <tr className="border-t border-ink-800/60">
                <td colSpan={4} className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={onAdd}
                    title={`Add another ${addableRole}`}
                    className="text-[11px] px-2.5 py-1 rounded bg-ink-700 hover:bg-ink-600 text-ink-200 hover:text-ink-100 border border-ink-600 transition"
                  >
                    + add {addableRole}
                  </button>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {atMax ? (
        <div className="text-[10px] text-ink-500 italic">
          At preset max ({preset.max}). Remove a row to add a different one.
        </div>
      ) : null}
    </div>
  );
}

// Convenience: build the initial topology when SetupForm picks a
// preset for the first time or the user switches presets.
export function topologyForPreset(
  presetId: string,
  agentCount: number,
  options?: {
    dedicatedAuditor?: boolean;
    plannerModel?: string;
    workerModel?: string;
    auditorModel?: string;
  },
): Topology {
  return synthesizeTopology(presetId, agentCount, options);
}
