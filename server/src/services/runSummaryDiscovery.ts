import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SwarmPhase, SwarmStatus, SwarmStatusRunConfig } from "../types.js";
import { normalizeSwarmStatusRunConfig } from "../types/run.js";

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
  return [...byId.values()].sort((a, b) => a.index - b.index);
}

/** Overlay live/summary agents onto the expected roster (topology / agentCount). */
export function mergeStatusAgents<T extends AgentStateShape>(
  live: readonly T[] | undefined,
  roster: readonly AgentStateShape[],
): T[] {
  if (!roster.length) return [...(live ?? [])];
  const byId = new Map<string, T>();
  for (const a of roster) {
    byId.set(a.id, { ...a } as T);
  }
  for (const a of live ?? []) {
    const prior = byId.get(a.id);
    byId.set(a.id, { ...prior, ...a } as T);
  }
  return [...byId.values()].sort((a, b) => a.index - b.index);
}

function resolveAgentRosterFromConfig(opts: {
  clonePath?: string;
  runConfig?: Record<string, unknown>;
  transcript?: unknown[];
}): AgentStateShape[] {
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
    const fromTx = inferAgentsFromTranscript(
      opts.transcript as Array<{ role?: string; text?: string; agentId?: string; agentIndex?: number }>,
    );
    if (fromTx.length > 0) return fromTx;
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
  const roster = resolveAgentRosterFromConfig(opts);
  const fromSum = opts.terminalSum ? shapeAgentsFromSummary(opts.terminalSum) : [];
  if (fromSum.length > 0) {
    return mergeStatusAgents(fromSum, roster.length ? roster : fromSum);
  }
  return roster;
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

/** Clone dirs under known parents that may hold run summaries (logs/ or summary.json). */
export function collectClonePathsForSummaryLookup(parentPaths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const norm = path.resolve(p);
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(p);
  };

  for (const parent of parentPaths) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".run-state.json") || name.endsWith(".run-state.json.tmp")) continue;
      const cloneDir = path.join(parent, name);
      try {
        if (!statSync(cloneDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const logsDir = path.join(cloneDir, "logs");
      if (existsSync(logsDir) || existsSync(path.join(cloneDir, "summary.json"))) {
        add(cloneDir);
      }
    }
  }
  return out;
}

/** Try each clone path via loadRunSummaryForRunId (newest summary first per clone). */
export function lookupTerminalSummaryOnDisk(
  runId: string,
  clonePaths: readonly string[],
): { summary: Record<string, unknown>; clonePath: string } | null {
  for (const clonePath of clonePaths) {
    const summary = loadRunSummaryForRunId(clonePath, runId);
    if (summary) return { summary, clonePath };
  }
  return null;
}

/** Build a terminal /status snapshot from a persisted run summary file. */
export function buildTerminalStatusFromSummary(
  sum: Record<string, unknown>,
  runId: string,
  clonePath: string,
): SwarmStatus {
  const effPhase = terminalPhaseFromStopReason(sum.stopReason) as SwarmPhase;
  const rc = (sum.runConfig as Record<string, unknown> | undefined) ?? { preset: sum.preset };
  const cp =
    (typeof sum.localPath === "string" && sum.localPath)
    || (typeof sum.clonePath === "string" && sum.clonePath)
    || clonePath;
  const shapedAgents = resolveStatusAgents({
    terminalSum: sum,
    clonePath: cp,
    runConfig: rc,
    transcript: Array.isArray(sum.transcript) ? sum.transcript : [],
  });
  const runConfig = rc
    ? normalizeSwarmStatusRunConfig({ ...rc, clonePath: cp } as SwarmStatusRunConfig & { localPath?: string })
    : undefined;
  return {
    phase: effPhase,
    round: 0,
    agents: shapedAgents,
    transcript: (sum.transcript || []) as SwarmStatus["transcript"],
    contract: sum.contract as SwarmStatus["contract"],
    summary: sum as unknown as import("../swarm/blackboard/summary.js").RunSummary,
    runId,
    runConfig,
    runStartedAt: typeof sum.startedAt === "number" ? sum.startedAt : undefined,
  };
}