import type { SwarmEvent, SwarmStatusSnapshot, TranscriptEntry } from "../types";
import type { SwarmPhase } from "../types";

/** Context from a successful /status hydrate used to tune WS guards. */
export type StatusHydrateContext = {
  statusHydrateOk: boolean;
  statusHasCompletedSummary: boolean;
};

const TERMINAL_PHASES = new Set<SwarmPhase>(["stopped", "completed", "failed"]);

/**
 * Drop agent_state / swarm_state on completed historical views so the sidebar
 * stays on FINAL AGENT STATS. Live runs (status ok, no stopReason) always pass.
 */
export function shouldDropTerminalGuardedEvent(
  ev: SwarmEvent,
  ctx: StatusHydrateContext & {
    phase: SwarmPhase;
    hasCompletedSummary: boolean;
  },
): boolean {
  if (ev.type !== "agent_state" && ev.type !== "swarm_state") return false;
  const liveByStatus = ctx.statusHydrateOk && !ctx.statusHasCompletedSummary;
  if (liveByStatus) return false;
  const isTerminalPhase = TERMINAL_PHASES.has(ctx.phase);
  return isTerminalPhase || ctx.hasCompletedSummary;
}

export function statusHasCompletedSummary(snap: SwarmStatusSnapshot): boolean {
  return !!(snap.summary && snap.summary.stopReason != null);
}

export function buildSyntheticRunStartDivider(
  runId: string,
  meta: {
    preset?: string;
    plannerModel?: string;
    workerModel?: string;
    agentCount?: number;
    repoUrl?: string;
  },
  idPrefix = "divider-hydrate",
): TranscriptEntry {
  return {
    id: `${idPrefix}-${Date.now()}`,
    role: "system",
    text: [
      "▸▸RUN-START▸▸",
      `runId=${runId}`,
      `preset=${meta.preset ?? ""}`,
      `plannerModel=${meta.plannerModel ?? ""}`,
      `workerModel=${meta.workerModel ?? ""}`,
      `agentCount=${meta.agentCount ?? ""}`,
      `repoUrl=${meta.repoUrl ?? ""}`,
    ].join("|"),
    ts: Date.now(),
  };
}

/** True when transcript already has a RUN-START divider for this runId. */
export function hasRunStartDivider(
  transcript: TranscriptEntry[],
  runId: string,
): boolean {
  return transcript.some(
    (t) =>
      t.role === "system" &&
      t.text?.startsWith("▸▸RUN-START▸▸") &&
      (t.text.match(/runId=([^|]+)/) ?? [])[1] === runId,
  );
}

/** Terminal phase from a completed run-summary (history fallback only). */
export function terminalPhaseFromSummary(summary: {
  stopReason?: string | null;
}): SwarmPhase | null {
  if (!summary.stopReason) return null;
  if (summary.stopReason === "completed") return "completed";
  return "stopped";
}