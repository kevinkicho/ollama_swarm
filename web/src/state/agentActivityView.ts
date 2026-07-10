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
  /** Primary card line: task + phase + elapsed when busy. */
  primaryLine: string;
};

export type AgentActivityViewOpts = {
  streamingMeta?: StreamingMeta;
  streamingText?: string;
  /** When run completed cleanly, stopped → "done". */
  runCompletedCleanly?: boolean;
  /** Preformatted elapsed (e.g. "12s"); optional. */
  elapsed?: string | null;
  retryAttempt?: number;
  retryMax?: number;
  retryReason?: string;
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

const IDLE_STATUSES = new Set<AgentState["status"]>([
  "ready",
  "stopped",
  "failed",
  "spawning",
]);

/**
 * Promote ready → thinking when control/data plane signals are still in flight.
 * Never demotes here — demotion is owned by viewAgentActivity (display) and
 * server markStatus(ready).
 */
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
  // Only promote from live stream or from activity while session is open.
  // Do not promote from stale waiting activity alone when control is idle
  // (matches dock: stale activity must not resurrect busy).
  const actBusy =
    actPhase
    && activityImpliesBusy(actPhase)
    && actPhase !== "done"
    && streamLive; // activity-only promote requires live stream; pure waiting needs markStatus
  if (!streamLive && !actBusy) return undefined;
  if (!streamLive && actPhase && isPreStreamActivityPhase(actPhase)) return undefined;
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

/**
 * Single projection for sidebar (and dock-aligned busy semantics).
 *
 * Durable rules:
 * 1. Live stream ⇒ busy (data plane lag-fill).
 * 2. agent_state thinking/retrying ⇒ busy UNLESS activity is already "done"
 *    and stream is not live (session closed; ready was missed → demote).
 * 3. Activity busy phases only count when control is busy OR stream is live
 *    (stale waiting after ready does NOT keep the card busy — dock rule).
 */
export function viewAgentActivity(
  agent: AgentState,
  act?: AgentActivityRecord,
  opts: AgentActivityViewOpts = {},
): AgentActivityView {
  const streamLive = hasLiveStreaming(opts.streamingMeta, opts.streamingText);
  const controlBusy =
    agent.status === "thinking" || agent.status === "retrying";
  const activityDone = act?.phase === "done";
  const sessionOpen = !!act && activityImpliesBusy(act.phase);

  // Stale activity after ready: ignore for busy (same as dock).
  const activityBusy =
    sessionOpen && (controlBusy || streamLive);

  // Session closed but agent_state still thinking → demote display.
  const stickyThinking = controlBusy && activityDone && !streamLive;

  const busy =
    streamLive
    || (controlBusy && !stickyThinking)
    || activityBusy;

  const phase: AgentActivityView["phase"] =
    stickyThinking
      ? "idle"
      : act?.phase
        ?? (streamLive
          ? "streaming"
          : agent.status === "thinking"
            ? "waiting"
            : agent.status === "retrying"
              ? "retrying"
              : "idle");

  const label = agent.activityLabel ?? act?.label;
  const isWaiting = busy && isPreStreamActivityPhase(phase) && !streamLive;

  const effectiveStatus: AgentState["status"] =
    stickyThinking
      ? "ready"
      : agent.status === "retrying" || phase === "retrying"
        ? "retrying"
        : busy
          ? "thinking"
          : agent.status;

  const busySince = busy
    ? agent.thinkingSince
      ?? opts.streamingMeta?.startedAt
      ?? act?.startedAt
    : undefined;

  let statusWord: string = agent.status;
  if (agent.status === "stopped" && opts.runCompletedCleanly) statusWord = "done";
  else if (stickyThinking) statusWord = "ready";
  else if (effectiveStatus === "retrying") statusWord = "retrying";
  else if (busy && phase === "streaming") statusWord = "streaming";
  else if (busy && isWaiting) statusWord = label?.trim() || "waiting";
  else if (busy) statusWord = label?.trim() || "thinking";
  else if (IDLE_STATUSES.has(agent.status)) statusWord = statusWord;

  const elapsed = opts.elapsed ?? null;
  const retryAttempt = opts.retryAttempt ?? agent.retryAttempt;
  const retryMax = opts.retryMax ?? agent.retryMax;
  const retryReason = opts.retryReason ?? agent.retryReason;

  let primaryLine: string;
  if (agent.status === "stopped" && opts.runCompletedCleanly) {
    primaryLine = "done";
  } else if (effectiveStatus === "retrying") {
    primaryLine =
      retryAttempt && retryMax
        ? `retrying ${retryAttempt}/${retryMax}${retryReason ? ` · ${retryReason}` : ""}${elapsed ? ` · ${elapsed}` : ""}`
        : `retrying${elapsed ? ` · ${elapsed}` : ""}`;
  } else if (busy) {
    const task = label?.trim();
    const phaseWord = isWaiting
      ? "waiting"
      : phase === "streaming"
        ? "streaming"
        : "thinking";
    const parts: string[] = [];
    if (task) parts.push(task);
    if (!task || task.toLowerCase() !== phaseWord) parts.push(phaseWord);
    if (elapsed) parts.push(elapsed);
    if (
      agent.activityAttempt
      && agent.activityMaxAttempts
      && agent.activityMaxAttempts > 1
    ) {
      parts.push(`(${agent.activityAttempt}/${agent.activityMaxAttempts})`);
    }
    primaryLine = parts.join(" · ");
  } else {
    primaryLine = statusWord;
  }

  return {
    phase,
    label,
    reason: act?.reason,
    isWaiting,
    statusWord,
    isBusy: busy,
    effectiveStatus,
    busySince,
    primaryLine,
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
