// T-Item-PerRunStore (2026-05-04): per-run zustand store Provider.
// Wraps a subtree (e.g. the /runs/:runId route) with a fresh store
// + opens its OWN per-runId WS subscription that dispatches into
// THAT store. Components inside the Provider read from this store
// via the existing `useSwarm()` hook (which reads from context).
//
// Lifecycle:
//   - mount: create store, open /ws?runId=X, hydrate from
//     /api/swarm/runs/:id/status snapshot
//   - runId change: tear down + recreate
//   - unmount: close socket
//
// Hydration: pulls the per-run status once on mount so the store
// has phase/agents/transcript/etc. WITHOUT waiting for the next WS
// event. Subsequent live events layer on top.

import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  SwarmStoreContext,
  createSwarmStore,
} from "./store";
import type { StoreApi } from "zustand";
import type { SwarmStore } from "./store";
import { applyEventToStore } from "./applyEvent";
import type { SwarmEvent, SwarmStatusSnapshot } from "../types";

interface SwarmStoreProviderProps {
  /** Run id to subscribe to. */
  runId: string;
  children: ReactNode;
}

export function SwarmStoreProvider({ runId, children }: SwarmStoreProviderProps) {
  // Create a fresh store ONCE per runId. useMemo with [runId] dep
  // means switching runIds tears down + recreates.
  const store = useMemo<StoreApi<SwarmStore>>(
    () => createSwarmStore(),
    [runId],
  );

  // Refs hold the latest store so socket callbacks don't capture
  // stale references across React StrictMode double-invokes.
  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;
    const ctrl = new AbortController();

    // Hydrate from REST snapshot first so the store is non-empty
    // before the live socket starts streaming. Best-effort — a
    // failed snapshot just means the UI is sparser until events
    // start landing.
    const hydrate = async () => {
      try {
        const res = await fetch(
          `/api/swarm/runs/${encodeURIComponent(runId)}/status`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const snap = (await res.json()) as SwarmStatusSnapshot;
        if (cancelled) return;
        const s = storeRef.current.getState();
        s.setPhase(snap.phase, snap.round);
        for (const a of snap.agents) s.upsertAgent(a);
        for (const e of snap.transcript) s.appendEntry(e);
        if (snap.summary) s.setSummary(snap.summary);
        if (snap.contract) s.setContract(snap.contract);
        if (snap.cloneState) s.setCloneState(snap.cloneState);
        if (snap.runConfig) s.setRunConfig(snap.runConfig);
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
        if (
          snap.mapperSlices &&
          Object.keys(snap.mapperSlices).length > 0
        ) {
          s.setMapperSlices(snap.mapperSlices);
        }
      } catch {
        // best-effort
      }
    };
    void hydrate();

    const open = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://127.0.0.1:${__BACKEND_PORT__}/ws?runId=${encodeURIComponent(runId)}`;
      const sock = new WebSocket(url);
      socket = sock;
      sock.onopen = () => {
        backoffMs = 500;
      };
      sock.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as SwarmEvent;
          applyEventToStore(parsed, storeRef.current.getState());
        } catch {
          // ignore non-JSON
        }
      };
      sock.onclose = () => {
        socket = null;
        if (cancelled) return;
        const delay = Math.min(backoffMs, 8000);
        backoffMs = Math.min(backoffMs * 2, 8000);
        reconnectTimer = setTimeout(open, delay);
      };
      sock.onerror = () => {
        sock.close();
      };
    };
    open();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        socket = null;
      }
    };
  }, [runId]);

  return (
    <SwarmStoreContext.Provider value={store}>
      {children}
    </SwarmStoreContext.Provider>
  );
}
