import { create } from "zustand";
import type {
  AgentState,
  BoardSnapshot,
  Claim,
  CloneState,
  ExitContract,
  Finding,
  LatencySample,
  RunConfigSnapshot,
  RunSummary,
  SwarmPhase,
  Todo,
  TranscriptEntry,
} from "../types";

// Unit 40: cap per-agent rolling window. 20 samples is enough for a
// sparkline to show "is the current wait unusually long vs. recent
// attempts?" without unbounded growth over a multi-hour run.
const LATENCY_WINDOW = 20;

interface SwarmStore {
  phase: SwarmPhase;
  round: number;
  agents: Record<string, AgentState>;
  transcript: TranscriptEntry[];
  streaming: Record<string, string>;
  todos: Record<string, Todo>;
  findings: Finding[];
  contract?: ExitContract;
  summary?: RunSummary;
  error?: string;
  latency: Record<string, LatencySample[]>;
  // Unit 47: latest clone_state event for the current run, or
  // undefined before the runner emits it. UI uses this to show the
  // "you're resuming an existing clone" banner.
  cloneState?: CloneState;
  // Unit 47: user has dismissed the resume banner for this run; the
  // banner stays hidden until the next reset (new run start).
  cloneBannerDismissed: boolean;
  // Unit 52a: wall-clock ms-since-epoch at which the orchestrator
  // started this run. Anchors the runtime ticker. Undefined when no
  // run has fired this session OR after reset().
  runStartedAt?: number;
  // Unit 52c: snapshot of the run's config (preset, models, paths)
  // captured from the same run_started event. Drives the
  // run-identity strip.
  runConfig?: RunConfigSnapshot;
  // Unit 52d: app-level run id (uuid) minted at run-start. Distinct
  // from opencode session ids. Used in the identifiers row for
  // click-to-copy + future cross-referencing of per-run artifacts.
  runId?: string;

  setPhase: (phase: SwarmPhase, round: number) => void;
  upsertAgent: (a: AgentState) => void;
  appendEntry: (e: TranscriptEntry) => void;
  setStreaming: (agentId: string, text: string) => void;
  clearStreaming: (agentId: string) => void;

  upsertTodo: (t: Todo) => void;
  applyClaim: (todoId: string, claim: Claim) => void;
  markCommitted: (todoId: string) => void;
  markStale: (todoId: string, reason: string, replanCount: number) => void;
  markSkipped: (todoId: string, reason: string) => void;
  applyReplan: (todoId: string, description: string, expectedFiles: string[], replanCount: number) => void;
  appendFinding: (f: Finding) => void;
  replaceBoard: (snapshot: BoardSnapshot) => void;
  setContract: (c: ExitContract) => void;
  setSummary: (s: RunSummary) => void;
  pushLatencySample: (agentId: string, sample: LatencySample) => void;
  setCloneState: (c: CloneState) => void;
  dismissCloneBanner: () => void;
  setRunStartedAt: (ts: number) => void;
  setRunConfig: (c: RunConfigSnapshot) => void;
  setRunId: (id: string) => void;

  setError: (msg: string | undefined) => void;
  reset: () => void;
}

export const useSwarm = create<SwarmStore>((set) => ({
  phase: "idle",
  round: 0,
  agents: {},
  transcript: [],
  streaming: {},
  todos: {},
  findings: [],
  contract: undefined,
  summary: undefined,
  error: undefined,
  latency: {},
  cloneState: undefined,
  cloneBannerDismissed: false,
  runStartedAt: undefined,
  runConfig: undefined,
  runId: undefined,

  setPhase: (phase, round) => set({ phase, round }),
  upsertAgent: (a) => set((s) => ({ agents: { ...s.agents, [a.id]: a } })),
  appendEntry: (e) =>
    set((s) => {
      if (s.transcript.some((t) => t.id === e.id)) return s;
      const nextStreaming = { ...s.streaming };
      if (e.agentId) delete nextStreaming[e.agentId];
      return { transcript: [...s.transcript, e], streaming: nextStreaming };
    }),
  setStreaming: (agentId, text) =>
    set((s) => ({ streaming: { ...s.streaming, [agentId]: text } })),
  clearStreaming: (agentId) =>
    set((s) => {
      if (!(agentId in s.streaming)) return s;
      const next = { ...s.streaming };
      delete next[agentId];
      return { streaming: next };
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
      // committedAt here is a UI-side approximation; a follow-up board_state
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
  applyReplan: (todoId, description, expectedFiles, replanCount) =>
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
  // Unit 47: clone_state arrives once per run. Setting it ALSO clears
  // the dismissed flag so a fresh run shows its banner even if a
  // prior banner was dismissed mid-session (each run has its own
  // dismissal scope).
  setCloneState: (c) => set({ cloneState: c, cloneBannerDismissed: false }),
  dismissCloneBanner: () => set({ cloneBannerDismissed: true }),
  setRunStartedAt: (ts) => set({ runStartedAt: ts }),
  setRunConfig: (c) => set({ runConfig: c }),
  setRunId: (id) => set({ runId: id }),

  setError: (msg) => set({ error: msg }),
  reset: () =>
    set({
      phase: "idle",
      round: 0,
      agents: {},
      transcript: [],
      streaming: {},
      todos: {},
      findings: [],
      contract: undefined,
      summary: undefined,
      error: undefined,
      latency: {},
      cloneState: undefined,
      cloneBannerDismissed: false,
      runStartedAt: undefined,
      runConfig: undefined,
      runId: undefined,
    }),
}));
