// 2026-04-27: helper that turns the heterogeneous "agents ready" prose
// each runner used to emit into a uniform structured summary the UI
// can render as an expandable per-agent grid.
//
// Used in tandem with appendSystem(text, summary) — the runner provides
// the human-readable text (preset-specific topology hints stay there)
// and a roleResolver callback that maps each agent to a free-form role
// label appropriate for the preset ("Planner", "Worker", "Drafter", etc).

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntrySummary } from "../types.js";

export interface AgentsReadySummaryInput {
  manager: AgentManager;
  preset: string;
  ready: readonly Agent[];
  requestedCount: number;
  spawnElapsedMs: number;
  /** Per-agent role label. The runner's preset decides naming
   *  (e.g. role-diff uses cfg.roles[i], blackboard uses
   *  "Planner"/"Worker"/"Auditor", etc). Returns the label for the
   *  given agent. */
  roleResolver: (agent: Agent) => string;
}

export function buildAgentsReadySummary(
  input: AgentsReadySummaryInput,
): Extract<TranscriptEntrySummary, { kind: "agents_ready" }> {
  return {
    kind: "agents_ready",
    preset: input.preset,
    readyCount: input.ready.length,
    requestedCount: input.requestedCount,
    spawnElapsedMs: input.spawnElapsedMs,
    agents: input.ready.map((a) => ({
      id: a.id,
      index: a.index,
      port: a.port,
      model: a.model,
      sessionId: a.sessionId,
      role: input.roleResolver(a),
      warmupMs: input.manager.getWarmupElapsedMs(a.id),
    })),
  };
}
