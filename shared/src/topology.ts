// Phase 1 of the topology refactor (#243): explicit per-agent specs
// replace the implicit `agentCount + roleForRow()` model. Topology
// becomes the source of truth in both UI and RunConfig; legacy fields
// (agentCount, plannerModel, workerModel, auditorModel) derive from
// it. See docs/active-work.md for the 4-phase plan.
//
// Server-side, when an older client posts without `topology`, the
// route layer synthesizes one via synthesizeTopology() so spawn
// behavior is identical. New UI posts an explicit topology and the
// server uses it directly. Phase 1 keeps both paths live; later
// phases drop the legacy paths once nothing uses them.

import { z } from "zod";

// All known per-agent role labels across every preset. Keep in sync
// with server/src/swarm/* role assignments and web/src/components/
// RunHistory.roleForRow.
export const AGENT_ROLES = [
  "planner",
  "worker",
  "auditor",
  "orchestrator",
  "mid-lead",
  "mapper",
  "reducer",
  "drafter",
  "explorer",
  "peer",
  "pro",
  "con",
  "judge",
  "role-diff",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

// Phase 2 of #243 (color palette): a small fixed set so users build
// muscle memory ("agent #3 is the green one") and the AgentPanel +
// transcript bubbles can pick a consistent border color. Tailwind
// names — runtime maps these to actual class strings.
export const AGENT_COLORS = [
  "emerald",
  "sky",
  "amber",
  "violet",
  "rose",
  "teal",
  "fuchsia",
  "lime",
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const AgentSpecSchema = z.object({
  index: z.number().int().min(1).max(16),
  role: z.enum(AGENT_ROLES),
  // Per-agent model override. Falls back to RunConfig.model when
  // absent. Phase 1 wires this through the same plumbing as the
  // existing plannerModel/workerModel/auditorModel fields.
  model: z.string().trim().min(1).max(200).optional(),
  // Whether the user can remove this row from the topology grid.
  // Structural slots (planner/auditor/orchestrator/judge/...) are
  // false; flexible workers/peers/mappers are true.
  removable: z.boolean(),
  // Phase 2 of #243: per-agent properties. All optional — the grid
  // hides their columns by default to stay scannable.
  //
  // tag — free-text specialization label (e.g. "tests-expert").
  //   Phase 2 surfaces it in AgentPanel + transcript bubbles for
  //   visual identification. Future phases wire it into planner
  //   claim routing so todos with matching tags route to specialized
  //   workers preferentially. Capped at 40 chars to fit chip layouts.
  tag: z.string().trim().max(40).optional(),
  // color — fixed-palette badge for AgentPanel cards + transcript
  //   bubbles. Cosmetic; helps the eye lock onto "agent #3" across
  //   the UI.
  color: z.enum(AGENT_COLORS).optional(),
  // temperature — opencode session sampling temperature. 0–2 range
  //   matches the OpenAI/Ollama convention. Empty = inherit the
  //   model default (no override). Runtime wiring lands incrementally;
  //   Phase 2 adds the schema + grid input.
  temperature: z.number().min(0).max(2).optional(),
  // promptAddendum — appended to this agent's opencode system
  //   prompt at session creation. Lets users specialize specific
  //   workers (e.g. "Focus on test files only.") without changing
  //   the preset's prompt template. Capped at 1000 chars to keep
  //   per-prompt overhead bounded.
  promptAddendum: z.string().trim().max(1000).optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const TopologySchema = z.object({
  agents: z.array(AgentSpecSchema).min(1).max(16),
});
export type Topology = z.infer<typeof TopologySchema>;

// Centralized role assignment — this is the function the legacy
// runtime code (Orchestrator, runners, RunHistory.roleForRow) was
// re-implementing in three places. Source of truth for the default
// role at a given index given preset+total.
export function defaultRoleForIndex(
  preset: string,
  index: number,
  totalAgents: number,
): AgentRole {
  switch (preset) {
    case "blackboard": {
      if (index === 1) return "planner";
      // Highest index is the auditor — matches the existing
      // RunHistory.roleForRow display logic. Whether that auditor is
      // spawned as a separate agent or folded into a worker is the
      // dedicatedAuditor flag's job; for topology purposes the role
      // label tracks the slot.
      if (index === totalAgents) return "auditor";
      return "worker";
    }
    case "orchestrator-worker":
      return index === 1 ? "orchestrator" : "worker";
    case "orchestrator-worker-deep": {
      if (index === 1) return "orchestrator";
      const remaining = Math.max(0, totalAgents - 1);
      const targetK = Math.max(1, Math.ceil(remaining / 6));
      const maxK = Math.max(1, Math.floor(remaining / 3));
      const k = Math.min(targetK, maxK);
      return index <= 1 + k ? "mid-lead" : "worker";
    }
    case "map-reduce":
      return index === 1 ? "reducer" : "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      if (index === 1) return "pro";
      if (index === 2) return "con";
      if (index === 3) return "judge";
      return "peer";
    default:
      return index === 1 ? "planner" : "worker";
  }
}

// True when a role is fixed-by-preset and the grid should not let the
// user delete it. Workers / mappers / drafters / explorers / peers
// are flexible — the user can scale their count up/down. Everything
// else is structural.
export function isRoleStructural(preset: string, role: AgentRole): boolean {
  // debate-judge is fixed at exactly 3 (pro/con/judge), so all rows
  // are structural regardless of role.
  if (preset === "debate-judge") return true;
  switch (role) {
    case "planner":
    case "auditor":
    case "orchestrator":
    case "mid-lead":
    case "reducer":
    case "judge":
    case "pro":
    case "con":
      return true;
    default:
      return false;
  }
}

// Synthesize a default topology from the legacy (preset, agentCount,
// per-role model) inputs. Used:
//   - server-side when an older client posts without topology
//   - web-side when picking a preset (the grid pre-fills via this)
//   - tests / fixtures
//
// dedicatedAuditor=true on blackboard adds one extra agent (the
// auditor), matching the existing `agentCount + 1` behavior in
// routes/swarm.ts comments. For other presets it's ignored.
export function synthesizeTopology(
  preset: string,
  agentCount: number,
  options?: {
    dedicatedAuditor?: boolean;
    plannerModel?: string;
    workerModel?: string;
    auditorModel?: string;
  },
): Topology {
  const total =
    preset === "blackboard" && options?.dedicatedAuditor
      ? agentCount + 1
      : agentCount;
  const agents: AgentSpec[] = [];
  for (let i = 1; i <= total; i++) {
    const role = defaultRoleForIndex(preset, i, total);
    let model: string | undefined;
    if (role === "planner" || role === "orchestrator" || role === "reducer" || role === "judge") {
      model = options?.plannerModel;
    } else if (role === "auditor") {
      model = options?.auditorModel ?? options?.plannerModel;
    } else {
      // worker / mid-lead / mapper / drafter / explorer / peer / pro / con / role-diff
      model = options?.workerModel;
    }
    agents.push({
      index: i,
      role,
      model,
      removable: !isRoleStructural(preset, role),
    });
  }
  return { agents };
}

// Phase 5 of #243: lookup helpers used by runners to fetch a
// specific agent's spec when wiring per-agent runtime overrides
// (promptAddendum, tag) into prompt calls. Optional-chained
// callers stay safe when topology is undefined (legacy clients).
export function findAgentSpec(
  topology: Topology | undefined,
  agentIndex: number,
): AgentSpec | undefined {
  return topology?.agents.find((a) => a.index === agentIndex);
}
export function getAgentAddendum(
  topology: Topology | undefined,
  agentIndex: number,
): string | undefined {
  const spec = findAgentSpec(topology, agentIndex);
  if (!spec?.promptAddendum) return undefined;
  const trimmed = spec.promptAddendum.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
export function getAgentTag(
  topology: Topology | undefined,
  agentIndex: number,
): string | undefined {
  const spec = findAgentSpec(topology, agentIndex);
  if (!spec?.tag) return undefined;
  const trimmed = spec.tag.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Inverse of synthesizeTopology — given a topology, derive the legacy
// fields the runners still consume. Used at the route boundary so
// the runner side stays unchanged in Phase 1.
export function deriveLegacyFields(topology: Topology, preset: string): {
  agentCount: number;
  dedicatedAuditor: boolean;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
} {
  const total = topology.agents.length;
  const hasAuditor = topology.agents.some((a) => a.role === "auditor");
  // For blackboard: agentCount excludes the auditor when
  // dedicatedAuditor is on (matches the legacy convention where the
  // auditor is counted as +1 on top of agentCount).
  const dedicatedAuditor = preset === "blackboard" && hasAuditor;
  const agentCount =
    preset === "blackboard" && dedicatedAuditor ? total - 1 : total;

  const planner = topology.agents.find(
    (a) => a.role === "planner" || a.role === "orchestrator" || a.role === "reducer",
  );
  const auditor = topology.agents.find((a) => a.role === "auditor");
  // First worker-ish role for the legacy workerModel field.
  const workerLike = topology.agents.find(
    (a) =>
      a.role === "worker" ||
      a.role === "mid-lead" ||
      a.role === "mapper" ||
      a.role === "drafter" ||
      a.role === "explorer" ||
      a.role === "peer",
  );
  return {
    agentCount,
    dedicatedAuditor,
    plannerModel: planner?.model,
    workerModel: workerLike?.model,
    auditorModel: auditor?.model,
  };
}
