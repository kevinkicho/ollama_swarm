import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** All summary.json paths under a clone (root, logs/, logs/<runId>/). Newest basename first. */
export function collectSummaryCandidates(clonePath: string): string[] {
  const candidates: string[] = [];
  const rootSum = path.join(clonePath, "summary.json");
  if (existsSync(rootSum)) candidates.push(rootSum);

  const logsDir = path.join(clonePath, "logs");
  let entries: string[] = [];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return uniqueSortedCandidates(candidates);
  }

  for (const e of entries) {
    const direct = path.join(logsDir, e);
    if (/^summary(?:-.*)?\.json$/.test(e)) {
      candidates.push(direct);
      continue;
    }
    try {
      if (!existsSync(direct) || !statSync(direct).isDirectory()) continue;
      for (const se of readdirSync(direct)) {
        if (/^summary(?:-.*)?\.json$/.test(se)) {
          candidates.push(path.join(direct, se));
        }
      }
    } catch {
      // skip unreadable subdir
    }
  }

  return uniqueSortedCandidates(candidates);
}

function uniqueSortedCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    const norm = path.resolve(c);
    if (seen.has(norm)) continue;
    seen.add(norm);
    unique.push(c);
  }
  return unique.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

function runIdMatches(sumRunId: unknown, runId: string): boolean {
  if (typeof sumRunId !== "string" || !sumRunId) return true;
  if (sumRunId === runId) return true;
  return sumRunId.startsWith(runId) || runId.startsWith(sumRunId);
}

/** Load the best matching terminal summary for a run from disk candidates. */
export function loadRunSummaryForRunId(
  clonePath: string,
  runId: string,
): Record<string, unknown> | null {
  for (const cand of collectSummaryCandidates(clonePath)) {
    try {
      if (!existsSync(cand)) continue;
      const sum = JSON.parse(readFileSync(cand, "utf8")) as Record<string, unknown>;
      if (sum && runIdMatches(sum.runId, runId)) {
        return sum;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function shapeAgentsFromSummary(summary: Record<string, unknown>): AgentStateShape[] {
  const agents = summary.agents;
  if (!Array.isArray(agents)) return [];
  return agents.map((pa: Record<string, unknown>) => ({
    id: String(pa.agentId ?? `agent-${pa.agentIndex ?? 0}`),
    index: Number(pa.agentIndex ?? 0),
    status: "stopped" as const,
    model: typeof pa.model === "string" ? pa.model : undefined,
  }));
}

function modelByIndexFromRunConfig(
  runConfig?: Record<string, unknown>,
): Map<number, string> | undefined {
  if (!runConfig) return undefined;
  const extras = (runConfig.extras ?? {}) as Record<string, unknown>;
  const topology = (runConfig.topology ?? extras.topology) as
    | { agents?: Array<{ index?: number; model?: string }> }
    | undefined;
  if (!topology?.agents?.length) return undefined;
  const map = new Map<number, string>();
  for (const a of topology.agents) {
    if (typeof a.index === "number" && typeof a.model === "string") {
      map.set(a.index, a.model);
    }
  }
  return map.size > 0 ? map : undefined;
}

export function shapeAgentsFromRoster(
  roster: Array<{ agentId?: string; id?: string; agentIndex?: number; index?: number }>,
  modelByIndex?: Map<number, string>,
): AgentStateShape[] {
  return roster
    .map((a) => {
      const index = Number(a.agentIndex ?? a.index ?? 0);
      const id = String(a.agentId ?? a.id ?? `agent-${index}`);
      return {
        id,
        index,
        status: "stopped" as const,
        model: modelByIndex?.get(index),
      };
    })
    .sort((a, b) => a.index - b.index);
}

export function shapeAgentsFromTopology(
  topology: { agents: Array<{ index: number; model?: string }> },
): AgentStateShape[] {
  return topology.agents
    .map((a) => ({
      id: `agent-${a.index}`,
      index: a.index,
      status: "stopped" as const,
      model: a.model,
    }))
    .sort((a, b) => a.index - b.index);
}

export function inferAgentsFromTranscript(
  transcript: Array<{ role?: string; text?: string; agentId?: string; agentIndex?: number }>,
): AgentStateShape[] {
  const byId = new Map<string, AgentStateShape>();
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
  return [...byId.values()].sort((a, b) => a.index - b.index);
}

/** True when agent roster should be read from blackboard-state.json. */
export function shouldUseBlackboardAgentRoster(
  runConfig?: Record<string, unknown>,
): boolean {
  if (!runConfig) return false;
  const extras = (runConfig.extras ?? {}) as Record<string, unknown>;
  const preset = String(runConfig.preset ?? extras.preset ?? "");
  return preset === "blackboard";
}

/** Best-effort sync read of `<clone>/blackboard-state.json`. */
export function readBlackboardStateSync(clonePath: string): Record<string, unknown> | null {
  const file = path.join(clonePath, "blackboard-state.json");
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Resolve sidebar agents when summary is missing or killAll cleared live state. */
export function resolveStatusAgents(opts: {
  terminalSum: Record<string, unknown> | null;
  clonePath?: string;
  runConfig?: Record<string, unknown>;
  transcript?: unknown[];
}): AgentStateShape[] {
  if (opts.terminalSum) {
    const fromSum = shapeAgentsFromSummary(opts.terminalSum);
    if (fromSum.length > 0) return fromSum;
  }

  const modelByIndex = modelByIndexFromRunConfig(opts.runConfig);

  if (opts.clonePath && shouldUseBlackboardAgentRoster(opts.runConfig)) {
    const bb = readBlackboardStateSync(opts.clonePath);
    if (bb) {
      const roster = bb.agentRoster;
      if (Array.isArray(roster) && roster.length > 0) {
        return shapeAgentsFromRoster(roster as Array<{ agentId: string; agentIndex: number }>, modelByIndex);
      }
      const perAgent = bb.perAgent;
      if (Array.isArray(perAgent) && perAgent.length > 0) {
        return shapeAgentsFromRoster(
          perAgent as Array<{ agentId: string; agentIndex: number }>,
          modelByIndex,
        );
      }
    }
  }

  const extras = (opts.runConfig?.extras ?? {}) as Record<string, unknown>;
  const topology = (opts.runConfig?.topology ?? extras.topology) as
    | { agents?: Array<{ index: number; model?: string }> }
    | undefined;
  if (topology?.agents?.length) {
    return shapeAgentsFromTopology({ agents: topology.agents });
  }

  if (Array.isArray(opts.transcript) && opts.transcript.length > 0) {
    return inferAgentsFromTranscript(
      opts.transcript as Array<{ role?: string; text?: string; agentId?: string; agentIndex?: number }>,
    );
  }

  const agentCount = Number(opts.runConfig?.agentCount ?? extras.agentCount);
  if (Number.isFinite(agentCount) && agentCount > 0) {
    const dedicatedAuditor = Boolean(opts.runConfig?.dedicatedAuditor ?? extras.dedicatedAuditor);
    const total = dedicatedAuditor ? agentCount + 1 : agentCount;
    const defaultModel =
      (typeof opts.runConfig?.workerModel === "string" && opts.runConfig.workerModel)
      || (typeof opts.runConfig?.model === "string" && opts.runConfig.model)
      || (typeof extras.workerModel === "string" && extras.workerModel)
      || undefined;
    return Array.from({ length: total }, (_, i) => {
      const index = i + 1;
      return {
        id: `agent-${index}`,
        index,
        status: "stopped" as const,
        model: modelByIndex?.get(index) ?? defaultModel,
      };
    });
  }

  return [];
}

export type AgentStateShape = {
  id: string;
  index: number;
  status: "stopped";
  model?: string;
};

export function terminalPhaseFromStopReason(stopReason: unknown): "completed" | "failed" | "stopped" {
  if (stopReason === "completed") return "completed";
  if (stopReason === "crash" || stopReason === "crashed") return "failed";
  return "stopped";
}