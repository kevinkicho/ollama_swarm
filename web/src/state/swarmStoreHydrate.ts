import type { StoreApi } from "zustand";
import type { SwarmEvent, SwarmStatusSnapshot, TranscriptEntry } from "../types";
import type { SwarmPhase } from "../types";
import type { SwarmStore } from "./store";
import { inferAgentsFromSnapshot, mergeAgentsForSnapshot } from "../lib/inferAgents";
import { isActiveSwarmPhase, isTerminalSwarmPhase } from "../lib/swarmPhase";
import { syncThinkGuardRefereeStore } from "./thinkGuardRefereeSync";
import {
  extractControlAdviceFromTranscript,
  extractControlAdviceFromEventRecords,
  mergeControlAdvice,
  type SwarmControlAdviceRecord,
} from "@ollama-swarm/shared/swarmControl/controlAdvice";
import { apiFetch } from "../lib/apiFetch";

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
  // Live runs must always accept lifecycle events — dropping agent_state while
  // agent_streaming still flows leaves the sidebar stuck on "ready".
  if (isActiveSwarmPhase(ctx.phase)) return false;
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

/** Agent ids that belong to the current run (topology or agentCount). */
export function allowedAgentIdsForRun(
  runConfig?: SwarmStatusSnapshot["runConfig"],
): Set<string> | null {
  if (!runConfig) return null;
  const topology = runConfig.topology;
  if (topology?.agents?.length) {
    return new Set(topology.agents.map((a) => `agent-${a.index}`));
  }
  const count = runConfig.agentCount;
  if (count == null || count < 1) return null;
  const total = runConfig.dedicatedAuditor ? count + 1 : count;
  return new Set(
    Array.from({ length: total }, (_, i) => `agent-${i + 1}`),
  );
}

/** Merge summary / transcript / event-log control advice into the store. */
export function hydrateControlAdviceToStore(
  store: StoreApi<SwarmStore>,
  sources: {
    summaryAdvice?: SwarmControlAdviceRecord[];
    transcript?: TranscriptEntry[];
    eventRecords?: ReadonlyArray<{ event?: { type?: string; ts?: number; [key: string]: unknown } }>;
  },
): void {
  const transcriptAdvice = sources.transcript
    ? extractControlAdviceFromTranscript(sources.transcript)
    : [];
  const eventAdvice = sources.eventRecords
    ? extractControlAdviceFromEventRecords(sources.eventRecords)
    : [];
  const merged = mergeControlAdvice(
    sources.summaryAdvice ?? [],
    transcriptAdvice,
    eventAdvice,
  );
  if (merged.length === 0) return;
  store.getState().replaceControlAdvice(merged);
}

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

  const snapSubphase = (snap as { planningSubphase?: SwarmStatusSnapshot["planningSubphase"] })
    .planningSubphase;
  if (snap.phase != null && snap.phase !== "idle") {
    s.setPhase(snap.phase as SwarmPhase, (snap as { round?: number }).round ?? 0, {
      ...(snapSubphase ? { planningSubphase: snapSubphase } : {}),
    });
  } else if (snap.phase === "idle" && s.transcript.length === 0) {
    s.setPhase("idle", (snap as { round?: number }).round ?? 0);
  }

  const healthSnap = snap as {
    drainEligible?: boolean;
    drainIneligibleReason?: string;
    capsRemaining?: {
      wallClockMsRemaining?: number;
      tokenBudgetRemaining?: number;
    };
    earlyStopDetail?: string;
  };
  if (
    healthSnap.drainEligible !== undefined ||
    healthSnap.drainIneligibleReason ||
    healthSnap.capsRemaining ||
    healthSnap.earlyStopDetail
  ) {
    s.setRunHealthFromStatus({
      drainEligible: healthSnap.drainEligible,
      drainIneligibleReason: healthSnap.drainIneligibleReason,
      capsRemaining: healthSnap.capsRemaining,
      earlyStopDetail: healthSnap.earlyStopDetail,
    });
  }

  if (upsertLiveAgents) {
    const roster = inferAgentsFromSnapshot({ ...snap, agents: [] });
    const agentsForSidebar = mergeAgentsForSnapshot(snap.agents ?? [], roster);
    if (agentsForSidebar.length > 0) {
      const allowed = allowedAgentIdsForRun(snap.runConfig);
      agentsForSidebar.forEach((a) => {
        const idx = a.index ?? (a as { agentIndex?: number }).agentIndex ?? 0;
        const id = a.id || (a as { agentId?: string }).agentId || `agent-${idx}`;
        if (allowed && !allowed.has(id)) return;
        const existing = store.getState().agents[id];
        const status = a.status || existing?.status || "ready";
        const merged = {
          ...existing,
          ...a,
          id,
          index: idx,
          status,
          model: a.model ?? existing?.model,
        } as Parameters<SwarmStore["upsertAgent"]>[0];
        if (status !== "thinking" && status !== "retrying") {
          merged.thinkingSince = undefined;
          merged.activityKind = undefined;
          merged.activityLabel = undefined;
          merged.activityAttempt = undefined;
          merged.activityMaxAttempts = undefined;
        }
        s.upsertAgent(merged);
      });
      if (allowed) {
        const cur = store.getState().agents;
        const pruned: typeof cur = {};
        for (const [id, agent] of Object.entries(cur)) {
          if (allowed.has(id)) pruned[id] = agent;
        }
        if (Object.keys(pruned).length !== Object.keys(cur).length) {
          store.setState({ agents: pruned });
        }
      }
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
  if (snap.thinkGuardReferee) {
    s.setThinkGuardReferee(snap.thinkGuardReferee);
  } else if (snap.runConfig) {
    syncThinkGuardRefereeStore(s);
  }
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
  // Restore control-plane activity BEFORE streaming so we do not use
  // setAgentActivity (which clears stream buffers on fresh waiting sessions).
  if (snap.agentActivity && Object.keys(snap.agentActivity).length > 0) {
    const cur = store.getState().agentActivity;
    const next = { ...cur };
    for (const [agentId, rec] of Object.entries(snap.agentActivity)) {
      next[agentId] = {
        phase: rec.phase,
        ts: rec.ts,
        startedAt: rec.startedAt ?? rec.ts,
        activityId: rec.activityId,
        kind: rec.kind,
        label: rec.label,
        attempt: rec.attempt,
        maxAttempts: rec.maxAttempts,
        reason: rec.reason,
      };
    }
    store.setState({ agentActivity: next });
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

  hydrateControlAdviceToStore(store, {
    summaryAdvice: (snap.summary as { controlAdvice?: SwarmControlAdviceRecord[] } | undefined)
      ?.controlAdvice,
    transcript: store.getState().transcript,
  });
}

/** Best-effort event-log replay for control advice on historical runs. */
export async function fetchAndHydrateControlAdviceFromEventLog(
  store: StoreApi<SwarmStore>,
  runId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await apiFetch(`/api/v2/event-log/runs/${encodeURIComponent(runId)}`,
      { signal },
    );
    if (!res.ok) return;
    const body = (await res.json()) as {
      records?: ReadonlyArray<{ event?: { type?: string; ts?: number; [key: string]: unknown } }>;
    };
    hydrateControlAdviceToStore(store, { eventRecords: body.records ?? [] });
  } catch {
    // best-effort
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
    const res = await apiFetch(statusUrl, { signal });
    if (!res.ok) return;
    const snap = (await res.json()) as SwarmStatusSnapshot;
    applyStatusSnapshotToStore(store, runId, snap);
  } catch {
    // best-effort
  }
}