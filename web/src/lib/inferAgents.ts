import type { AgentState, TranscriptEntry } from "../types";

/** Client-side fallback when /status returns agents: [] without a terminal summary. */
/** Overlay partial /status agents onto the full expected roster. */
export function mergeAgentsForSnapshot<T extends AgentState>(
  live: readonly T[],
  roster: readonly AgentState[],
): T[] {
  if (!roster.length) return [...live];
  const byId = new Map<string, T>();
  for (const a of roster) {
    byId.set(a.id, { ...a } as T);
  }
  for (const a of live) {
    const prior = byId.get(a.id);
    byId.set(a.id, { ...prior, ...a } as T);
  }
  return [...byId.values()].sort((a, b) => a.index - b.index);
}

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
      const bulk = e.text.match(
        /(\d+)\/(\d+)\s+agents ready\s*[—-]\s*models:\s*(.+)/i,
      );
      if (bulk) {
        const count = Number(bulk[2]);
        const models = bulk[3]!.split(",").map((s) => s.trim()).filter(Boolean);
        for (let i = 1; i <= count; i++) {
          const id = `agent-${i}`;
          byId.set(id, {
            id,
            index: i,
            status: "stopped",
            model: models[i - 1] ?? models[0],
          });
        }
      }
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