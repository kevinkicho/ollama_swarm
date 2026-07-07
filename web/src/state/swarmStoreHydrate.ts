import type { StoreApi } from "zustand";
import type { SwarmEvent, SwarmStatusSnapshot, TranscriptEntry } from "../types";
import type { SwarmPhase } from "../types";
import type { SwarmStore } from "./store";
import { inferAgentsFromSnapshot } from "../lib/inferAgents";
import { isTerminalSwarmPhase } from "../lib/swarmPhase";

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

/** Grace period after WS open so on-connect transcript replay is buffered before drain. */
export const WS_REPLAY_GRACE_MS = 200;

/** Hard cap — never block hydration forever if WS cannot connect. */
export const HYDRATE_MAX_WAIT_MS = 8000;

export type ApplyStatusSnapshotOptions = {
  /** When false, skip agent upserts (completed runs keep final summary stats). */
  upsertLiveAgents?: boolean;
  /** When true, only hydrate transcript if store has fewer entries than server. */
  preferLongerTranscript?: boolean;
};

/**
 * Merge a REST /status snapshot into a store. Transcript is applied BEFORE
 * setPhase so an incidental idle/stopped phase cannot wipe hydrated bubbles.
 */
export function applyStatusSnapshotToStore(
  store: StoreApi<SwarmStore>,
  runId: string,
  snap: SwarmStatusSnapshot,
  opts: ApplyStatusSnapshotOptions = {},
): void {
  const s = store.getState();
  const completed = statusHasCompletedSummary(snap);
  const upsertLiveAgents = opts.upsertLiveAgents ?? !completed;

  if (snap.transcript?.length) {
    const curLen = s.transcript.length;
    const serverLen = snap.transcript.length;
    const shouldHydrate =
      !opts.preferLongerTranscript || !completed || curLen < serverLen;
    if (shouldHydrate) {
      s.hydrateTranscriptEntries(snap.transcript);
    }
  }

  if (snap.phase != null && snap.phase !== "idle") {
    s.setPhase(snap.phase as SwarmPhase, (snap as { round?: number }).round ?? 0);
  } else if (snap.phase === "idle" && s.transcript.length === 0) {
    s.setPhase("idle", (snap as { round?: number }).round ?? 0);
  }

  if (upsertLiveAgents) {
    const agentsForSidebar =
      snap.agents?.length ? snap.agents : inferAgentsFromSnapshot(snap);
    if (agentsForSidebar.length > 0) {
      agentsForSidebar.forEach((a) => {
        const idx = a.index ?? (a as { agentIndex?: number }).agentIndex ?? 0;
        const id = a.id || (a as { agentId?: string }).agentId || `agent-${idx}`;
        s.upsertAgent({
          id,
          index: idx,
          status: a.status || "ready",
          model: a.model,
        } as Parameters<SwarmStore["upsertAgent"]>[0]);
      });
    }
  }

  if (!hasRunStartDivider(store.getState().transcript, runId)) {
    s.hydrateTranscriptEntries([
      buildSyntheticRunStartDivider(runId, {
        preset: (snap as { preset?: string }).preset || snap.runConfig?.preset,
        plannerModel: snap.runConfig?.plannerModel,
        workerModel: snap.runConfig?.workerModel,
        agentCount: snap.runConfig?.agentCount,
        repoUrl: snap.runConfig?.repoUrl,
      }),
    ]);
  }

  if (snap.runConfig) s.setRunConfig({ ...snap.runConfig });
  if (snap.summary) s.setSummary(snap.summary);
  if (snap.contract) s.setContract(snap.contract);
  if (snap.cloneState) s.setCloneState(snap.cloneState);
  if (snap.runId) s.setRunId(snap.runId);
  if (snap.runStartedAt) s.setRunStartedAt(snap.runStartedAt);
  if (snap.board) {
    s.replaceBoard({
      todos: snap.board.todos,
      findings: snap.board.findings,
    });
  }
  if (snap.latency) {
    for (const [agentId, samples] of Object.entries(snap.latency)) {
      for (const sample of samples) s.pushLatencySample(agentId, sample);
    }
  }
  if (snap.streaming) {
    for (const [agentId, entry] of Object.entries(snap.streaming)) {
      s.setStreaming(agentId, entry.text);
    }
  }
  if (snap.pheromones) {
    for (const [file, state] of Object.entries(snap.pheromones)) {
      s.upsertPheromone(file, state);
    }
  }
  if (snap.mapperSlices && Object.keys(snap.mapperSlices).length > 0) {
    s.setMapperSlices(snap.mapperSlices);
  }
}

/** Re-fetch status when post-hydrate transcript is still empty on an active run. */
export async function catchUpEmptyTranscript(
  store: StoreApi<SwarmStore>,
  runId: string,
  statusUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const st = store.getState();
  if (st.transcript.length > 0) return;
  if (isTerminalSwarmPhase(st.phase)) return;
  try {
    const res = await fetch(statusUrl, { signal });
    if (!res.ok) return;
    const snap = (await res.json()) as SwarmStatusSnapshot;
    applyStatusSnapshotToStore(store, runId, snap);
  } catch {
    // best-effort
  }
}