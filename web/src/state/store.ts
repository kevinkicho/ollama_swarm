import { create } from "zustand";
import type { AgentState, SwarmPhase, TranscriptEntry } from "../types";

interface SwarmStore {
  phase: SwarmPhase;
  round: number;
  agents: Record<string, AgentState>;
  transcript: TranscriptEntry[];
  streaming: Record<string, string>;
  error?: string;

  setPhase: (phase: SwarmPhase, round: number) => void;
  upsertAgent: (a: AgentState) => void;
  appendEntry: (e: TranscriptEntry) => void;
  setStreaming: (agentId: string, text: string) => void;
  clearStreaming: (agentId: string) => void;
  setError: (msg: string | undefined) => void;
  reset: () => void;
}

export const useSwarm = create<SwarmStore>((set) => ({
  phase: "idle",
  round: 0,
  agents: {},
  transcript: [],
  streaming: {},
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
  setError: (msg) => set({ error: msg }),
  reset: () => set({ phase: "idle", round: 0, agents: {}, transcript: [], streaming: {}, error: undefined }),
}));
