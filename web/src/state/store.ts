import { create, useStore } from "zustand";
import type { StoreApi, StateCreator } from "zustand";
import { createContext, useContext } from "react";
import type {
  AgentState,
  BoardSnapshot,
  Claim,
  CloneState,
  ExitContract,
  Finding,
  LatencySample,
  PheromoneEntry,
  RunConfigSnapshot,
  RunSummary,
  SwarmPhase,
  Todo,
  TranscriptEntry,
} from "../types";
import type { ChatMessage } from "../components/BrainStartChat";
import { mergeTranscriptEntry } from "./transcriptMerge.js";
import type { AgentActivityRecord } from "./agentActivityProjection.js";
import { patchAgentForLiveSignals } from "./agentActivityView.js";
import type {
  ConformanceSample,
  DirectiveAmendment,
  DriftSample,
  RunStartDividerInfo,
  SwarmControlAdvice,
  SwarmStore,
} from "./swarmStoreTypes.js";

export { mergeTranscriptEntry } from "./transcriptMerge.js";
export type { TranscriptMergeSlice } from "./transcriptMerge.js";
export type { AgentActivityRecord } from "./agentActivityProjection.js";
export type {
  ConformanceSample,
  DirectiveAmendment,
  DriftSample,
  RunStartDividerInfo,
  SwarmControlAdvice,
  SwarmStore,
} from "./swarmStoreTypes.js";

// Unit 40: cap per-agent rolling window. 20 samples is enough for a
// sparkline to show "is the current wait unusually long vs. recent
// attempts?" without unbounded growth over a multi-hour run.
const LATENCY_WINDOW = 20;

// #295: cap conformance sparkline window. 30 samples × 90s ≈ 45 min
// of history. Plenty for the IdentityStrip gauge; the run summary has
// the full series anyway.
const CONFORMANCE_WINDOW = 30;

const CONTROL_ADVICE_WINDOW = 40;

// T-Item-PerRunStore (2026-05-04): factory + Context for per-run
// store scoping. The default singleton store backs the legacy "/" route
// (and any component called outside a Provider). The /runs/:runId
// route wraps its subtree in <SwarmStoreProvider store={createSwarmStore()}>
// + opens a per-run WS subscription that dispatches into THAT store.
//
// Components keep calling `useSwarm((s) => s.field)` exactly as
// before — the new `useSwarm` reads the per-run store from context
// when present + falls back to the singleton when absent.
//
// Direct API access (`useSwarm.getState()` etc., used by useSwarmSocket
// + MetricsPanel's type extraction) targets the singleton — that's
// the legacy behavior, preserved verbatim.

/** Initializer fn used by both the singleton and the per-run factory.
 *  Single source of truth for the store shape + actions. */
const swarmStoreInitializer: StateCreator<SwarmStore> = (set) => ({
  phase: "idle",
  round: 0,
  agents: {},
  transcript: [],
  streaming: {},
  streamingMeta: {},
  agentActivity: {},
  todos: {},
  findings: [],
  contract: undefined,
  summary: undefined,
  error: undefined,
  latency: {},
  conformance: [],
  drift: [],
  amendments: [],
  cloneState: undefined,
  cloneBannerDismissed: false,
  runStartedAt: undefined,
  runConfig: undefined,
  thinkGuardReferee: undefined,
  controlAdvice: [],
  wallClockCapMin: undefined,
  ambitionTiers: undefined,
  runId: undefined,
  pheromones: {},
  mapperSlices: {},
  outcome: undefined,
  brainChatHistory: [],
  useCaseFilters: [],
  transcriptPlainListLatched: false,
  drainEligible: undefined,
  drainIneligibleReason: undefined,
  capsRemaining: undefined,
  earlyStopDetail: undefined,
  pipelinePhase: undefined,

  latchTranscriptPlainList: () =>
    set((s) => (s.transcriptPlainListLatched ? s : { transcriptPlainListLatched: true })),

  setRunHealthFromStatus: (patch) =>
    set((s) => ({
      drainEligible: patch.drainEligible ?? s.drainEligible,
      drainIneligibleReason: patch.drainIneligibleReason ?? s.drainIneligibleReason,
      capsRemaining: patch.capsRemaining ?? s.capsRemaining,
      earlyStopDetail:
        patch.earlyStopDetail !== undefined
          ? patch.earlyStopDetail
          : s.earlyStopDetail,
      pipelinePhase:
        patch.pipelinePhase === null
          ? undefined
          : patch.pipelinePhase !== undefined
            ? patch.pipelinePhase
            : s.pipelinePhase,
    })),

  setPhase: (phase, round, opts) =>
    set((s) => {
      const isTerminal = phase === "completed" || phase === "stopped" || phase === "failed";
      const latchLive = !isTerminal && phase !== "idle";
      const planningSubphase =
        opts?.planningSubphase !== undefined
          ? opts.planningSubphase
          : phase === "seeding" || phase === "planning"
            ? s.planningSubphase
            : undefined;
      if (isTerminal) {
        const agents = { ...s.agents };
        for (const [id, agent] of Object.entries(agents)) {
          if (agent.status === "thinking" || agent.status === "retrying") {
            agents[id] = {
              ...agent,
              status: "ready",
              thinkingSince: undefined,
              activityKind: undefined,
              activityLabel: undefined,
              activityAttempt: undefined,
              activityMaxAttempts: undefined,
            };
          }
        }
        return {
          phase,
          round,
          planningSubphase: undefined,
          streaming: {},
          streamingMeta: {},
          agentActivity: {},
          agents,
          pipelinePhase: undefined,
          // Keep plain list latched through stop — do not flip to virtual.
          transcriptPlainListLatched: s.transcriptPlainListLatched || latchLive,
        };
      }
      if (phase === "idle") {
        // Only wipe transcript on explicit idle reset (reset()), not on status/WS
        // hydration — refreshing mid-run used to call setPhase(idle) and erase bubbles.
        const clearTranscript = opts?.clearTranscriptOnIdle === true;
        return {
          phase,
          round,
          planningSubphase: undefined,
          ...(clearTranscript ? { transcript: [] } : {}),
          streaming: {},
          streamingMeta: {},
          agentActivity: {},
          agents: {},
        };
      }
      return {
        phase,
        round,
        planningSubphase,
        ...(latchLive ? { transcriptPlainListLatched: true } : {}),
      };
    }),
  upsertAgent: (a: any) => set((s) => {
    // Defense-in-depth for review hydration: summary.agents use agentId/agentIndex (PerAgentStat),
    // live use id/index (AgentState). Normalize so sidebar never shows "Agent undefined" and index is always number.
    const norm = {
      ...a,
      id: a.id || a.agentId || `agent-${a.index ?? a.agentIndex ?? 0}`,
      index: (a.index ?? a.agentIndex ?? 0) as number,
    };
    return { agents: { ...s.agents, [norm.id]: norm } };
  }),
  replaceAgents: (list) =>
    set((s) => {
      const agents: Record<string, AgentState> = {};
      for (const a of list) {
        const id = a.id || `agent-${a.index ?? 0}`;
        agents[id] = {
          ...a,
          id,
          index: (a.index ?? 0) as number,
        };
      }
      // Empty roster: also drop activity/stream ghosts from prior phase.
      if (list.length === 0) {
        return {
          agents: {},
          agentActivity: {},
          streaming: {},
          streamingMeta: {},
        };
      }
      // Keep activity/stream only for agents still in the roster.
      const nextActivity: typeof s.agentActivity = {};
      const nextStreaming: typeof s.streaming = {};
      const nextMeta: typeof s.streamingMeta = {};
      for (const id of Object.keys(agents)) {
        if (s.agentActivity[id]) nextActivity[id] = s.agentActivity[id];
        if (s.streaming[id] !== undefined) nextStreaming[id] = s.streaming[id];
        if (s.streamingMeta[id]) nextMeta[id] = s.streamingMeta[id];
      }
      return {
        agents,
        agentActivity: nextActivity,
        streaming: nextStreaming,
        streamingMeta: nextMeta,
      };
    }),
  clearTranscript: () => set({ transcript: [] }),
  removeTranscriptEntry: (id) =>
    set((s) => {
      if (!s.transcript.some((e) => e.id === id)) return s;
      return { transcript: s.transcript.filter((e) => e.id !== id) };
    }),

  appendEntry: (e) =>
    set((s) => {
      const merged = mergeTranscriptEntry(
        {
          transcript: s.transcript,
          streaming: s.streaming,
          streamingMeta: s.streamingMeta,
        },
        e,
      );
      if (!merged) return s;
      return {
        ...merged,
        transcriptPlainListLatched: true,
      };
    }),
  hydrateTranscriptEntries: (entries) =>
    set((s) => {
      if (!entries.length) return s;
      let slice = {
        transcript: s.transcript,
        streaming: s.streaming,
        streamingMeta: s.streamingMeta,
      };
      let changed = false;
      for (const e of entries) {
        const next = mergeTranscriptEntry(slice, e);
        if (next) {
          slice = next;
          changed = true;
        }
      }
      if (!changed) return s;
      return {
        ...slice,
        transcriptPlainListLatched: s.transcriptPlainListLatched || slice.transcript.length > 0,
      };
    }),
  setStreaming: (agentId, text) =>
    set((s) => {
      const now = Date.now();
      const prior = s.streamingMeta[agentId];
      const nextMetaEntry = {
        startedAt: prior?.startedAt ?? now,
        lastTextAt: now,
        status: "live" as const,
        endedAt: undefined,
      };
      const nextMeta = {
        ...s.streamingMeta,
        [agentId]: nextMetaEntry,
      };
      const patched = patchAgentForLiveSignals(s.agents[agentId], {
        streamingMeta: nextMetaEntry,
        streamingText: text,
        activity: s.agentActivity[agentId],
        now,
      });
      if (!patched) {
        return { streaming: { ...s.streaming, [agentId]: text }, streamingMeta: nextMeta };
      }
      return {
        streaming: { ...s.streaming, [agentId]: text },
        streamingMeta: nextMeta,
        agents: { ...s.agents, [agentId]: patched },
      };
    }),
  clearStreaming: (agentId) =>
    set((s) => {
      const haveText = agentId in s.streaming;
      const haveMeta = agentId in s.streamingMeta;
      if (!haveText && !haveMeta) return s;
      const next = { ...s.streaming };
      const nextMeta = { ...s.streamingMeta };
      delete next[agentId];
      delete nextMeta[agentId];
      return { streaming: next, streamingMeta: nextMeta };
    }),
  // Task #176 Phase A: ended → "done" but keep the bubble visible.
  // The transcript_append's existing delete-from-streaming side
  // effect will clear it once the matching transcript entry lands.
  // Safety: a 30s sweeper in StreamingDock removes stragglers if
  // the transcript_append never arrives.
  markStreamingEnded: (agentId) =>
    set((s) => {
      if (!(agentId in s.streamingMeta)) return s;
      const prior = s.streamingMeta[agentId];
      // Stream text is folded into the final agent bubble by mergeTranscriptEntry
      // on transcript_append (streamSnapshot + prune). Avoid a duplicate
      // agent-stream row here — that was causing paired bubbles in council runs.
      return {
        streamingMeta: {
          ...s.streamingMeta,
          [agentId]: { ...prior, status: "done", endedAt: Date.now() },
        },
      };
    }),
  setAgentActivity: (ev) =>
    set((s) => {
      const prior = s.agentActivity[ev.agentId];
      const freshSession =
        (ev.phase === "queued" || ev.phase === "waiting")
        && (!prior || prior.phase === "done" || prior.activityId !== ev.activityId);
      const startedAt = freshSession ? ev.ts : (prior?.startedAt ?? ev.ts);
      let streaming = s.streaming;
      let streamingMeta = s.streamingMeta;
      if (freshSession && (ev.phase === "queued" || ev.phase === "waiting")) {
        if (ev.agentId in streaming || ev.agentId in streamingMeta) {
          streaming = { ...streaming };
          streamingMeta = { ...streamingMeta };
          delete streaming[ev.agentId];
          delete streamingMeta[ev.agentId];
        }
      }
      // Ring buffer: keep recent transitions for AgentPanel timeline (B6).
      const HISTORY_LIMIT = 40;
      const priorHist = prior?.history ?? [];
      const entry = {
        phase: ev.phase,
        ts: ev.ts,
        kind: ev.kind ?? prior?.kind,
        label: ev.label ?? prior?.label,
        activityId: ev.activityId ?? prior?.activityId,
      };
      const history = [...priorHist, entry].slice(-HISTORY_LIMIT);
      const nextActivity: AgentActivityRecord = {
        phase: ev.phase,
        ts: ev.ts,
        startedAt,
        activityId: ev.activityId ?? prior?.activityId,
        kind: ev.kind ?? prior?.kind,
        label: ev.label ?? prior?.label,
        attempt: ev.attempt ?? prior?.attempt,
        maxAttempts: ev.maxAttempts ?? prior?.maxAttempts,
        reason:
          ev.phase === "done"
            ? undefined
            : ev.reason !== undefined
              ? ev.reason
              : prior?.reason,
        history,
      };
      const patched = patchAgentForLiveSignals(s.agents[ev.agentId], {
        activity: nextActivity,
        streamingMeta: streamingMeta[ev.agentId],
        streamingText: streaming[ev.agentId],
        now: ev.ts,
      });
      return {
        streaming,
        streamingMeta,
        agentActivity: {
          ...s.agentActivity,
          [ev.agentId]: nextActivity,
        },
        ...(patched
          ? { agents: { ...s.agents, [ev.agentId]: patched } }
          : {}),
      };
    }),

  upsertTodo: (t) => set((s) => ({ todos: { ...s.todos, [t.id]: t } })),
  applyClaim: (todoId, claim) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: { ...s.todos, [todoId]: { ...existing, status: "claimed", claim } },
      };
    }),
  markCommitted: (todoId) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      // committedAt here is a UI-side approximation; a follow-up queue_state
      // snapshot replaces it with the authoritative server timestamp.
      return {
        todos: {
          ...s.todos,
          [todoId]: { ...existing, status: "committed", committedAt: Date.now() },
        },
      };
    }),
  markStale: (todoId, reason, replanCount) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: {
          ...s.todos,
          [todoId]: { ...existing, status: "stale", staleReason: reason, replanCount },
        },
      };
    }),
  markSkipped: (todoId, reason) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: {
          ...s.todos,
          [todoId]: { ...existing, status: "skipped", skippedReason: reason },
        },
      };
    }),
  applyReplan: (todoId, description, expectedFiles, replanCount, expectedAnchors) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: {
          ...s.todos,
          [todoId]: {
            ...existing,
            description,
            expectedFiles,
            replanCount,
            // Audit fix (2026-04-28): apply anchor revisions when the
            // replanner explicitly revised them. undefined = keep prior.
            ...(expectedAnchors !== undefined ? { expectedAnchors } : {}),
            status: "open",
            staleReason: undefined,
            claim: undefined,
          },
        },
      };
    }),
  appendFinding: (f) =>
    set((s) => {
      if (s.findings.some((existing) => existing.id === f.id)) return s;
      return { findings: [...s.findings, f] };
    }),
  replaceBoard: (snapshot) =>
    set(() => {
      const todos: Record<string, Todo> = {};
      for (const t of snapshot.todos) todos[t.id] = t;
      return { todos, findings: snapshot.findings.slice() };
    }),
  setContract: (c) => set({ contract: c }),
  setSummary: (s) => set({ summary: s }),
  pushLatencySample: (agentId, sample) =>
    set((s) => {
      const existing = s.latency[agentId] ?? [];
      const next = existing.concat(sample);
      if (next.length > LATENCY_WINDOW) next.splice(0, next.length - LATENCY_WINDOW);
      return { latency: { ...s.latency, [agentId]: next } };
    }),
  pushConformanceSample: (sample) =>
    set((s) => {
      const next = s.conformance.concat(sample);
      if (next.length > CONFORMANCE_WINDOW) {
        next.splice(0, next.length - CONFORMANCE_WINDOW);
      }
      return { conformance: next };
    }),
  pushDriftSample: (sample) =>
    set((s) => {
      const next = s.drift.concat(sample);
      if (next.length > CONFORMANCE_WINDOW) {
        next.splice(0, next.length - CONFORMANCE_WINDOW);
      }
      return { drift: next };
    }),
  pushAmendment: (amendment) =>
    set((s) => ({ amendments: s.amendments.concat(amendment) })),
  pushControlAdvice: (advice) =>
    set((s) => {
      const next = s.controlAdvice.concat(advice);
      if (next.length > CONTROL_ADVICE_WINDOW) {
        next.splice(0, next.length - CONTROL_ADVICE_WINDOW);
      }
      return { controlAdvice: next };
    }),
  replaceControlAdvice: (advice) =>
    set({
      controlAdvice: advice.slice(-CONTROL_ADVICE_WINDOW),
    }),
  // Unit 47: clone_state arrives once per run. Setting it ALSO clears
  // the dismissed flag so a fresh run shows its banner even if a
  // prior banner was dismissed mid-session (each run has its own
  // dismissal scope).
  setCloneState: (c) => set({ cloneState: c, cloneBannerDismissed: false }),
  dismissCloneBanner: () => set({ cloneBannerDismissed: true }),
  setRunStartedAt: (ts) => set({ runStartedAt: ts }),
  setRunConfig: (c) => set({ runConfig: c }),
  patchRunConfig: (patch) =>
    set((s) => (s.runConfig ? { runConfig: { ...s.runConfig, ...patch } } : {})),
  setThinkGuardReferee: (b) => set({ thinkGuardReferee: b }),
  setRunId: (id) => set({ runId: id }),
  // Brain chat history per-run
  setBrainChatHistory: (history: ChatMessage[]) => set({ brainChatHistory: history }),
  appendBrainChatMessage: (msg: ChatMessage) =>
    set((s) => ({ brainChatHistory: [...s.brainChatHistory, msg] })),

  // Use-case filters for Swarm Mode card (interactive from Brain chat tables)
  setUseCaseFilters: (filters: string[]) => set({ useCaseFilters: filters }),
  upsertPheromone: (file, state) =>
    set((s) => ({ pheromones: { ...s.pheromones, [file]: state } })),
  setMapperSlices: (slices) => set({ mapperSlices: { ...slices } }),
  setOutcome: (outcome) => set({ outcome }),

  setError: (msg) =>
    set((s) =>
      msg === undefined
        ? { error: undefined }
        : { error: { message: msg, runId: s.runId, ts: Date.now() } },
    ),
  dismissError: () => set({ error: undefined }),
  reset: () =>
    set({
      phase: "idle",
      round: 0,
      agents: {},
      transcript: [],
      streaming: {}, streamingMeta: {},
      agentActivity: {},
      todos: {},
      findings: [],
      contract: undefined,
      summary: undefined,
      error: undefined,
      latency: {},
      conformance: [],
      drift: [],
      amendments: [],
      cloneState: undefined,
      cloneBannerDismissed: false,
      runStartedAt: undefined,
      runConfig: undefined,
      thinkGuardReferee: undefined,
      controlAdvice: [],
      wallClockCapMin: undefined,
      ambitionTiers: undefined,
      runId: undefined,
      pheromones: {},
      mapperSlices: {},
      outcome: undefined,
      transcriptPlainListLatched: false,
      drainEligible: undefined,
      drainIneligibleReason: undefined,
      capsRemaining: undefined,
      earlyStopDetail: undefined,
      pipelinePhase: undefined,
    }),
  // Task #37 (partial): clear per-run state when a new run kicks off
  // WITHOUT blowing away transcript/findings/board — those are the
  // history the user may still want to scroll. This addresses the
  // Agent N leftover problem (role-diff's 5 agents lingering after
  // council started with 4) without destroying context from the prior
  // run.
  // Task #46: emits a structured divider marker with run metadata
  // (runId + preset + models + agentCount + repo) so the Transcript
  // renderer can show a rich horizontal-rule block instead of a plain
  // "— new run started —" line. The divider's text uses a sentinel
  // prefix "▸▸RUN-START▸▸" so Transcript.tsx can detect it and render
  // a custom component; fall back to the plain text when no metadata
  // is supplied (test rigs, future callers that lack the fields).
  resetForNewRun: (info) =>
    set((s) => {
      // Lighter reset (Task #37): drop per-run live state (agents, streaming, latency,
      // blackboard panels, etc.) on run boundary so we don't leak from prior run.
      // DO NOT clear transcript: preserve hydrated/early messages. Prepend the
      // RUN-START divider (idempotent via dedup in append) so the start message
      // is visible at top even on WS re-delivery for live runs.
      // This fixes lost initial messages and "start run message not showing".
      const blackboardReset: Partial<SwarmStore> = {
        contract: undefined,
        todos: {},
        findings: [],
        summary: undefined,
        pheromones: {},
        mapperSlices: {},
        outcome: undefined,
        error: undefined,
        brainChatHistory: [],
        useCaseFilters: [],
        controlAdvice: [],
      };
      const text = info
        ? [
            "▸▸RUN-START▸▸",
            `runId=${info.runId ?? ""}`,
            `preset=${info.preset ?? ""}`,
            `plannerModel=${info.plannerModel ?? ""}`,
            `workerModel=${info.workerModel ?? ""}`,
            `agentCount=${info.agentCount ?? ""}`,
            `repoUrl=${info.repoUrl ?? ""}`,
          ].join("|")
        : "— new run started —";
      const divider = {
        id: `divider-${Date.now()}`,
        role: "system" as const,
        text,
        ts: Date.now(),
      };
      // Prepend only if not already starting with a divider for this runId (dedup similar to append).
      const first = s.transcript[0];
      const already = first && first.text && first.text.startsWith("▸▸RUN-START▸▸") &&
        (first.text.match(/runId=([^|]+)/) ?? [])[1] === (text.match(/runId=([^|]+)/) ?? [])[1];
      let newTranscript = already ? s.transcript : [divider, ...s.transcript];
      // Extra safety: if a divider exists anywhere (from prior appends), move the first one to position 0.
      const dIdx = newTranscript.findIndex((t: any) => t.text && t.text.startsWith("▸▸RUN-START▸▸"));
      if (dIdx > 0) {
        const d = newTranscript[dIdx];
        newTranscript = [d, ...newTranscript.filter((_: any, i: number) => i !== dIdx)];
      }
      return {
        agents: {},
        streaming: {}, streamingMeta: {},
        agentActivity: {},
        latency: {},
        conformance: [],
        drift: [],
        amendments: [],
        earlyStopDetail: undefined,
        pipelinePhase: undefined,
        drainEligible: undefined,
        drainIneligibleReason: undefined,
        capsRemaining: undefined,
        ...blackboardReset,
        transcript: newTranscript,
        transcriptPlainListLatched: true,
      };
    }),
});

/** Factory: returns a fresh SwarmStore. Each /runs/:runId route
 *  scope creates its own via SwarmStoreProvider. */
export function createSwarmStore(): StoreApi<SwarmStore> {
  return create<SwarmStore>()(swarmStoreInitializer);
}

/** Singleton store — backs the legacy "/" route + any caller without
 *  a Provider. Constructed at module load. */
export const swarmSingletonStore: StoreApi<SwarmStore> = createSwarmStore();
const singletonStore = swarmSingletonStore;

/** Context the per-run Provider populates with a scoped store. */
export const SwarmStoreContext = createContext<StoreApi<SwarmStore> | null>(
  null,
);

/** Read the active store: per-run from context if present, else singleton. */
function useResolvedSwarmStore(): StoreApi<SwarmStore> {
  const ctx = useContext(SwarmStoreContext);
  return ctx ?? singletonStore;
}

/** Public hook: components keep the existing `useSwarm((s) => s.field)`
 *  shape. Internally consults context-or-singleton. The bare-arg
 *  `useSwarm()` overload returns the full state for back-compat with
 *  EventLogMirrorPanel's "subscribe to everything" use case. */
export function useSwarm(): SwarmStore;
export function useSwarm<U>(selector: (s: SwarmStore) => U): U;
export function useSwarm<U>(selector?: (s: SwarmStore) => U): U | SwarmStore {
  const store = useResolvedSwarmStore();
  if (selector) return useStore(store, selector);
  return useStore(store);
}

// Direct API access — preserved for back-compat with callers that
// reach into the singleton (e.g. useSwarmSocket dispatches; type
// extraction via ReturnType<typeof useSwarm.getState>). These ALWAYS
// target the singleton. Per-run dispatch is the per-run Provider's
// responsibility (it owns the new store reference directly).
useSwarm.getState = singletonStore.getState;
useSwarm.setState = singletonStore.setState;
useSwarm.subscribe = singletonStore.subscribe;
