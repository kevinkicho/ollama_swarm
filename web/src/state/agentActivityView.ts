import { isBrainAgentName } from "@ollama-swarm/shared/brainAlias";
import type { AgentState } from "../types";
import type { AgentActivityRecord, StreamingMeta } from "./agentActivityProjection";
import { isPreStreamActivityPhase } from "./agentActivityPhases";

export type AgentActivityView = {
  phase: AgentActivityRecord["phase"] | "idle";
  label?: string;
  reason?: string;
  /** True when waiting for first byte (provider cold-start / retry, no stream). */
  isWaiting: boolean;
  /** Sidebar primary status word — task label while prompt is in flight. */
  statusWord: string;
  /** Busy for sidebar glow / elapsed — includes live streaming when agent_state lags. */
  isBusy: boolean;
  /** Status used for dot color / ticker — may differ from agent.status when streams are live. */
  effectiveStatus: AgentState["status"];
  /** Wall-clock anchor for elapsed labels (thinkingSince or stream startedAt). */
  busySince?: number;
};

export type AgentActivityViewOpts = {
  streamingMeta?: StreamingMeta;
  streamingText?: string;
};

function hasLiveStreaming(
  streamingMeta?: StreamingMeta,
  streamingText?: string,
): boolean {
  return streamingMeta?.status === "live" && (streamingText?.length ?? 0) > 0;
}

function activityImpliesBusy(phase: AgentActivityView["phase"]): boolean {
  return phase === "streaming" || isPreStreamActivityPhase(phase);
}

/** Promote ready → thinking when control/data plane signals are still in flight. */
export function patchAgentForLiveSignals(
  agent: AgentState | undefined,
  opts: {
    activity?: Pick<AgentActivityRecord, "phase" | "label" | "startedAt" | "ts">;
    streamingMeta?: StreamingMeta;
    streamingText?: string;
    now?: number;
  },
): AgentState | undefined {
  if (!agent) return undefined;
  if (agent.status === "thinking" || agent.status === "retrying") return undefined;
  const now = opts.now ?? Date.now();
  const actPhase = opts.activity?.phase;
  const streamLive = hasLiveStreaming(opts.streamingMeta, opts.streamingText);
  const actBusy = actPhase ? activityImpliesBusy(actPhase) : false;
  if (!streamLive && !actBusy) return undefined;
  const busySince =
    agent.thinkingSince
    ?? opts.streamingMeta?.startedAt
    ?? opts.activity?.startedAt
    ?? opts.activity?.ts
    ?? now;
  return {
    ...agent,
    status: actPhase === "retrying" ? "retrying" : "thinking",
    thinkingSince: busySince,
    activityLabel: agent.activityLabel ?? opts.activity?.label,
  };
}

export function viewAgentActivity(
  agent: AgentState,
  act?: AgentActivityRecord,
  opts: AgentActivityViewOpts = {},
): AgentActivityView {
  const streamLive = hasLiveStreaming(opts.streamingMeta, opts.streamingText);
  const phase =
    act?.phase
    ?? (streamLive ? "streaming" : agent.status === "thinking" ? "waiting" : agent.status === "retrying" ? "retrying" : "idle");
  const label = agent.activityLabel ?? act?.label;
  const isWaiting = isPreStreamActivityPhase(phase) && !streamLive;
  const busy =
    agent.status === "thinking"
    || agent.status === "retrying"
    || streamLive
    || activityImpliesBusy(phase);
  const effectiveStatus: AgentState["status"] =
    agent.status === "retrying" || phase === "retrying"
      ? "retrying"
      : busy
        ? "thinking"
        : agent.status;
  const busySince =
    agent.thinkingSince
    ?? opts.streamingMeta?.startedAt
    ?? act?.startedAt;
  let statusWord: string = agent.status;
  if (effectiveStatus === "retrying") statusWord = "retrying";
  else if (busy && phase === "streaming") statusWord = "streaming";
  else if (busy && isWaiting) statusWord = label?.trim() || "waiting";
  return {
    phase,
    label,
    reason: act?.reason,
    isWaiting,
    statusWord,
    isBusy: busy,
    effectiveStatus,
    busySince,
  };
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