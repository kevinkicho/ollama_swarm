import type { ToolFailureRecord } from "./types.js";

export function toolFailureFingerprint(tool: string, error: string): string {
  const norm = error
    .slice(0, 120)
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${tool}|${norm}`;
}

export class ToolFailureTracker {
  private readonly byAgent = new Map<string, Map<string, ToolFailureRecord>>();

  record(agentId: string, tool: string, error: string): ToolFailureRecord {
    const fp = toolFailureFingerprint(tool, error);
    let agentMap = this.byAgent.get(agentId);
    if (!agentMap) {
      agentMap = new Map();
      this.byAgent.set(agentId, agentMap);
    }
    const prev = agentMap.get(fp);
    const next: ToolFailureRecord = {
      tool,
      error: error.slice(0, 200),
      count: (prev?.count ?? 0) + 1,
      lastAt: Date.now(),
    };
    agentMap.set(fp, next);
    return next;
  }

  get(agentId: string, tool: string, error: string): ToolFailureRecord | undefined {
    return this.byAgent.get(agentId)?.get(toolFailureFingerprint(tool, error));
  }

  topRecurring(agentId: string, minCount: number): ToolFailureRecord[] {
    const agentMap = this.byAgent.get(agentId);
    if (!agentMap) return [];
    return [...agentMap.values()].filter((r) => r.count >= minCount).sort((a, b) => b.count - a.count);
  }

  resetAgent(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  resetAll(): void {
    this.byAgent.clear();
  }
}