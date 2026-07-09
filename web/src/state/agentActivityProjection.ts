import type { AgentState } from "../types";
import { isPreStreamActivityPhase } from "./agentActivityPhases";

export type AgentActivityRecord = {
  phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
  ts: number;
  startedAt: number;
  activityId?: string;
  kind?: string;
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
};

export type StreamingMeta = {
  startedAt: number;
  lastTextAt: number;
  status: "live" | "done";
  endedAt?: number;
};

export type StreamingDockSlot = {
  agentId: string;
  agentIndex: number;
  text: string;
  meta?: StreamingMeta;
  /** Waiting for first provider byte — no activity/stream yet. */
  waiting?: boolean;
  /** Provider has started responding; WS text may still be in flight. */
  receiving?: boolean;
  waitingSince?: number;
  waitingLabel?: string;
  waitingPhase?: "queued" | "waiting" | "retrying";
  waitingReason?: string;
};

const BUSY_STATUSES = new Set<AgentState["status"]>(["thinking", "retrying"]);

/** Prefer roster index; fall back to agent-N id so missing store rows never default to 0 (Brain). */
export function resolveAgentIndex(agentId: string, agent?: AgentState): number {
  if (agent?.index != null && Number.isFinite(agent.index)) return agent.index;
  const m = agentId.match(/^agent-(\d+)$/);
  if (m) return Number(m[1]);
  return 0;
}

function hasLiveStreamingText(
  agentId: string,
  streaming: Record<string, string>,
  streamingMeta: Record<string, StreamingMeta>,
): boolean {
  const meta = streamingMeta[agentId];
  if (meta?.status !== "live") return false;
  return (streaming[agentId]?.length ?? 0) > 0;
}

/**
 * Merge agent_state + agent_activity + agent_streaming into stable dock slots.
 * Busy agents without tokens still get a placeholder bubble.
 */
export function buildStreamingDockSlots(
  agents: Record<string, AgentState>,
  streaming: Record<string, string>,
  streamingMeta: Record<string, StreamingMeta>,
  agentActivity: Record<string, AgentActivityRecord> = {},
): StreamingDockSlot[] {
  const slotIds = new Set<string>();

  for (const id of Object.keys(streaming)) slotIds.add(id);

  for (const [id, agent] of Object.entries(agents)) {
    if (!BUSY_STATUSES.has(agent.status)) continue;
    if (!hasLiveStreamingText(id, streaming, streamingMeta)) slotIds.add(id);
  }

  // Stale agent_activity (waiting/retrying) must not resurrect dock slots
  // after markStatus(ready) — only busy agents get placeholders.
  for (const [id, act] of Object.entries(agentActivity)) {
    if (!isPreStreamActivityPhase(act.phase)) continue;
    const agent = agents[id];
    if (agent && BUSY_STATUSES.has(agent.status)) slotIds.add(id);
  }

  return [...slotIds]
    .map((agentId) => {
      const agent = agents[agentId];
      const act = agentActivity[agentId];
      const text = streaming[agentId] ?? "";
      const meta = streamingMeta[agentId];
      const agentBusy = BUSY_STATUSES.has(agent?.status ?? "ready");
      const busySince = agent?.thinkingSince ?? act?.startedAt;
      const busyElapsedMs =
        busySince != null ? Math.max(0, Date.now() - busySince) : 0;
      const hasTaskLabel = !!(agent?.activityLabel ?? act?.label);
      const receiving =
        agentBusy &&
        text.length === 0 &&
        (act?.phase === "streaming"
          || meta?.status === "live"
          || (hasTaskLabel && busyElapsedMs > 3_000));
      const waiting = agentBusy && text.length === 0 && !receiving;

      return {
        agentId,
        agentIndex: resolveAgentIndex(agentId, agent),
        text,
        meta,
        waiting,
        receiving,
        waitingSince: agent?.thinkingSince ?? act?.startedAt,
        waitingLabel: agent?.activityLabel ?? act?.label,
        waitingPhase:
          agent?.status === "retrying" || act?.phase === "retrying"
            ? ("retrying" as const)
            : ("waiting" as const),
        waitingReason: agent?.retryReason ?? act?.reason,
      };
    })
    .filter((slot) => {
      const agent = agents[slot.agentId];
      const busy = BUSY_STATUSES.has(agent?.status ?? "ready");
      const hasStream = slot.text.length > 0 || slot.meta?.status === "live";
      return busy || hasStream || slot.meta?.status === "done";
    })
    .sort((a, b) => a.agentIndex - b.agentIndex);
}