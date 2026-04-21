import { create } from "zustand";
import type {
  AgentState,
  BoardSnapshot,
  Claim,
  ExitContract,
  Finding,
  RunSummary,
  SwarmPhase,
  Todo,
  TranscriptEntry,
} from "../types";

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
    }),
}));
