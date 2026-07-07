import type { AgentState, TranscriptEntry } from "../types";

/** Client-side fallback when /status returns agents: [] without a terminal summary. */
export function inferAgentsFromSnapshot(
  snap: {
    agents?: AgentState[];
    transcript?: TranscriptEntry[];
    runConfig?: {
      agentCount?: number;
      dedicatedAuditor?: boolean;
      workerModel?: string;
      model?: string;
      topology?: { agents: Array<{ index: number; model?: string; role?: string }> };
      extras?: Record<string, unknown>;
    };
  },
): AgentState[] {
  if (snap.agents?.length) return snap.agents;

  const rc = snap.runConfig;
  const extras = (rc?.extras ?? {}) as Record<string, unknown>;
  const topology =
    rc?.topology
    ?? (extras.topology as { agents: Array<{ index: number; model?: string; role?: string }> } | undefined);
  if (topology?.agents?.length) {
    return topology.agents.map((a) => ({
      id: `agent-${a.index}`,
      index: a.index,
      status: "stopped",
      model: a.model,
    }));
  }

  const transcript = snap.transcript ?? [];
  const byId = new Map<string, AgentState>();
  for (const e of transcript) {
    if (e.agentId && e.agentIndex != null) {
      byId.set(e.agentId, {
        id: e.agentId,
        index: e.agentIndex,
        status: "stopped",
      });
    }
    if (e.role === "system" && e.text) {
      const m = e.text.match(
        /(?:Planner|Worker|Auditor) agent (agent-\d+) ready \(model=([^)]+)\)/,
      );
      if (m) {
        const id = m[1]!;
        const index = Number(id.replace("agent-", ""));
        byId.set(id, { id, index, status: "stopped", model: m[2] });
      }
    }
  }
  if (byId.size > 0) {
    return [...byId.values()].sort((a, b) => a.index - b.index);
  }

  const agentCount = rc?.agentCount ?? Number(extras.agentCount);
  if (!agentCount || agentCount <= 0) return [];

  const dedicatedAuditor = rc?.dedicatedAuditor ?? Boolean(extras.dedicatedAuditor);
  const total = dedicatedAuditor ? agentCount + 1 : agentCount;
  const defaultModel =
    rc?.workerModel
    ?? rc?.model
    ?? (typeof extras.workerModel === "string" ? extras.workerModel : undefined);
  return Array.from({ length: total }, (_, i) => {
    const index = i + 1;
    return {
      id: `agent-${index}`,
      index,
      status: "stopped" as const,
      model: defaultModel,
    };
  });
}