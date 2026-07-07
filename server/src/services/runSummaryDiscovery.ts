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