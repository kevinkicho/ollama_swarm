import { isBrainAgentName } from "@ollama-swarm/shared/brainAlias";
import type { AgentState } from "../types";
import type { AgentActivityRecord } from "./agentActivityProjection";
import { isPreStreamActivityPhase } from "./agentActivityPhases";

export type AgentActivityView = {
  phase: AgentActivityRecord["phase"] | "idle";
  label?: string;
  reason?: string;
  /** True when waiting for first byte (provider cold-start / retry, no stream). */
  isWaiting: boolean;
  /** Sidebar primary status word — task label while prompt is in flight. */
  statusWord: string;
};

export function viewAgentActivity(
  agent: AgentState,
  act?: AgentActivityRecord,
): AgentActivityView {
  const phase =
    act?.phase
    ?? (agent.status === "thinking" ? "waiting" : agent.status === "retrying" ? "retrying" : "idle");
  const label = agent.activityLabel ?? act?.label;
  const isWaiting = isPreStreamActivityPhase(phase);
  let statusWord: string = agent.status;
  if (agent.status === "retrying") statusWord = "retrying";
  else if (agent.status === "thinking" && phase === "streaming") statusWord = "streaming";
  else if (agent.status === "thinking" && isWaiting) statusWord = label?.trim() || "waiting";
  return { phase, label, reason: act?.reason, isWaiting, statusWord };
}

export function activityStubId(agentId: string): string {
  return `activity-stub-${agentId}`;
}

export function activityStubText(
  agentIndex: number,
  label: string | undefined,
  phase: "queued" | "waiting" | "retrying" | "streaming",
  reason?: string,
  agentId?: string,
): string {
  const who = isBrainAgentName(agentId ?? "") ? "Brain" : `Agent ${agentIndex}`;
  const task = label ?? "prompt";
  if (phase === "retrying") {
    return `${who}: ${task} — retrying${reason ? ` (${reason})` : ""}…`;
  }
  if (phase === "streaming") {
    return `${who}: ${task} — streaming…`;
  }
  if (phase === "queued" || phase === "waiting") {
    return `${who}: ${task} — awaiting provider…`;
  }
  return `${who}: ${task} — waiting…`;
}