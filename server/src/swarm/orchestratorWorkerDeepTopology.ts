// Pure orchestrator-worker-deep agent-index layout (no runner imports).

export const TARGET_WORKERS_PER_MID_LEAD = 6;

export const DEEP_OW_MIN_AGENTS = 4;

export interface DeepTopology {
  orchestratorIndex: number;
  midLeadIndices: number[];
  workerIndices: number[];
  workerByMidLead: number[][];
}

export function computeDeepTopology(agentCount: number): DeepTopology {
  if (agentCount < DEEP_OW_MIN_AGENTS) {
    throw new Error(
      `orchestrator-worker-deep needs at least ${DEEP_OW_MIN_AGENTS} agents (1 orchestrator + 1 mid-lead + 2 workers); got ${agentCount}`,
    );
  }
  const remaining = agentCount - 1;
  const targetK = Math.max(1, Math.ceil(remaining / TARGET_WORKERS_PER_MID_LEAD));
  const maxK = Math.max(1, Math.floor(remaining / 3));
  const k = Math.min(targetK, maxK);
  const midLeadIndices = Array.from({ length: k }, (_, i) => i + 2);
  const workerIndices = Array.from({ length: remaining - k }, (_, i) => i + 2 + k);
  const workerByMidLead: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < workerIndices.length; i++) {
    workerByMidLead[i % k]!.push(workerIndices[i]!);
  }
  return {
    orchestratorIndex: 1,
    midLeadIndices,
    workerIndices,
    workerByMidLead,
  };
}