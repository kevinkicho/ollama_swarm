import type { Agent } from "../../services/AgentManager.js";
import type { SwarmEvent } from "../../types.js";
import type { ToolResultHook } from "../../tools/ToolDispatcher.js";
import type { SwarmControlCenter } from "./SwarmControlCenter.js";

export interface CouncilControlHookDeps {
  getSwarmControl?: () => SwarmControlCenter;
  getCoachAgent?: () => Agent | undefined;
  clonePath?: string;
  runId?: string;
  appendSystem?: (msg: string) => void;
  emit?: (e: SwarmEvent) => void;
}

export function buildCouncilToolCoachHook(
  agent: Agent,
  deps: CouncilControlHookDeps,
): ToolResultHook | undefined {
  const control = deps.getSwarmControl?.();
  const coach = deps.getCoachAgent?.() ?? agent;
  if (!control) return undefined;
  return (info) => {
    if (info.ok) return;
    control.recordToolFailure(agent.id, info.tool, info.error ?? "tool error", info.preview, {
      agent: coach,
      clonePath: deps.clonePath,
      runId: deps.runId,
      appendSystem: deps.appendSystem,
      emit: deps.emit,
    });
  };
}