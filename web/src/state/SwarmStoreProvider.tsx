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
// event. WS events during hydrate are buffered (Task #120 parity) and
// drained in order once the snapshot merge completes.

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
import { wsUrlForRunId } from "../hooks/useSwarmSocket";
import {
  buildSyntheticRunStartDivider,
  hasRunStartDivider,
  shouldDropTerminalGuardedEvent,
  statusHasCompletedSummary,
  terminalPhaseFromSummary,
  type StatusHydrateContext,
} from "./swarmStoreHydrate";

interface SwarmStoreProviderProps {
  /** Run id to subscribe to. */
  runId: string;
  children: ReactNode;
}

function applyStatusSnapshot(
  store: StoreApi<SwarmStore>,
  runId: string,
  snap: SwarmStatusSnapshot,
): void {
  const s = store.getState();
  if (snap.phase != null) {
    s.setPhase(snap.phase as any, (snap as any).round ?? 0);
  }
  const completed = statusHasCompletedSummary(snap);
  if (snap.agents && Array.isArray(snap.agents) && !completed) {
    snap.agents.forEach((a: any) => {
      const idx = a.index ?? a.agentIndex ?? 0;
      const id = a.id || a.agentId || `agent-${idx}`;
      s.upsertAgent({ id, index: idx, status: a.status || "ready", model: a.model } as any);
    });
  }
  if (snap.runConfig) {
    s.setRunConfig({ ...snap.runConfig });
  }
  if (snap.transcript?.length) {
    s.hydrateTranscriptEntries(snap.transcript);
  }
  if (!hasRunStartDivider(store.getState().transcript, runId)) {
    s.hydrateTranscriptEntries([
      buildSyntheticRunStartDivider(runId, {
        preset: (snap as any).preset || snap.runConfig?.preset,
        plannerModel: snap.runConfig?.plannerModel,
        workerModel: snap.runConfig?.workerModel,
        agentCount: snap.runConfig?.agentCount,
        repoUrl: snap.runConfig?.repoUrl,
      }),
    ]);
  }
  if (snap.summary) {
    s.setSummary(snap.summary);
  }
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

export function SwarmStoreProvider({ runId, children }: SwarmStoreProviderProps) {
  const store = useMemo<StoreApi<SwarmStore>>(() => {
    const newStore = createSwarmStore();
    newStore.setState((state) => ({
      ...state,
      runId,
      phase: "spawning",
    }));
    return newStore;
  }, [runId]);

  const storeRef = useRef<StoreApi<SwarmStore>>(store);
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

    let isHydrating = true;
    const pendingEvents: SwarmEvent[] = [];
    const statusCtx: StatusHydrateContext = {
      statusHydrateOk: false,
      statusHasCompletedSummary: false,
    };

    const applyWsEvent = (parsed: SwarmEvent) => {
      const st = storeRef.current.getState();
      const hasCompletedSummary = !!(st.summary && st.summary.stopReason != null);
      if (
        shouldDropTerminalGuardedEvent(parsed, {
          ...statusCtx,
          phase: st.phase,
          hasCompletedSummary,
        })
      ) {
        return;
      }
      applyEventToStore(parsed, storeRef.current.getState());
    };

    const dispatchWsEvent = (parsed: SwarmEvent) => {
      if (isHydrating) {
        pendingEvents.push(parsed);
        return;
      }
      applyWsEvent(parsed);
    };

    const finishHydration = () => {
      isHydrating = false;
      while (pendingEvents.length > 0) {
        const ev = pendingEvents.shift();
        if (ev) applyWsEvent(ev);
      }
    };

    const isFake = runId.startsWith("fake-") || runId.includes("fake");

    const hydrateFromHistoryFallback = async () => {
      const listRes = await fetch(`/api/swarm/runs`, { signal: ctrl.signal });
      if (!listRes.ok) return;

      const listBody = await listRes.json();
      const match = (listBody.runs || []).find(
        (r: any) =>
          r.runId === runId ||
          (runId && (r.runId.startsWith(runId) || runId.startsWith(r.runId))),
      );
      const s = storeRef.current.getState();
      s.setRunId(runId);
      if (!match?.clonePath) return;

      const params = new URLSearchParams({ clonePath: match.clonePath, runId });
      const sumRes = await fetch(`/api/swarm/run-summary?${params.toString()}`, {
        signal: ctrl.signal,
      });
      if (!sumRes.ok) return;

      const summary = await sumRes.json();
      const cp = summary.localPath || match.clonePath;
      if (cp) {
        const prevCfg = s.runConfig || {};
        s.setRunConfig({
          ...prevCfg,
          clonePath: cp,
          preset: summary.preset || match.preset,
          model: summary.model || match.model,
        } as any);
      }
      if (summary.startedAt) s.setRunStartedAt(summary.startedAt);
      if (summary.transcript?.length) {
        s.hydrateTranscriptEntries(summary.transcript);
      }
      if (!hasRunStartDivider(store.getState().transcript, runId)) {
        s.hydrateTranscriptEntries([
          buildSyntheticRunStartDivider(
            runId,
            {
              preset: summary.preset || match.preset,
              plannerModel: summary.runConfig?.plannerModel,
              workerModel: summary.runConfig?.workerModel,
              agentCount: summary.runConfig?.agentCount,
              repoUrl: summary.runConfig?.repoUrl,
            },
            "divider-fallback",
          ),
        ]);
      }
      if (summary) s.setSummary(summary);
      if (summary.contract) s.setContract(summary.contract);
      const terminal = terminalPhaseFromSummary(summary);
      if (terminal) {
        s.setPhase(terminal, 0);
        statusCtx.statusHasCompletedSummary = true;
      }
    };

    const hydrate = async () => {
      if (isFake) return;
      try {
        const res = await fetch(
          `/api/swarm/runs/${encodeURIComponent(runId)}/status`,
          { signal: ctrl.signal },
        );
        if (res.ok) {
          const snap = (await res.json()) as SwarmStatusSnapshot;
          if (cancelled) return;
          statusCtx.statusHydrateOk = true;
          statusCtx.statusHasCompletedSummary = statusHasCompletedSummary(snap);
          applyStatusSnapshot(storeRef.current, runId, snap);
        } else if (!cancelled) {
          await hydrateFromHistoryFallback();
        }
      } catch {
        if (!cancelled && !statusCtx.statusHydrateOk) {
          try {
            await hydrateFromHistoryFallback();
          } catch {
            // best-effort history path
          }
        }
      } finally {
        if (!cancelled) finishHydration();
      }
    };

    const open = () => {
      if (cancelled) return;
      const url = wsUrlForRunId(runId);
      const sock = new WebSocket(url);
      socket = sock;
      sock.onopen = () => {
        backoffMs = 500;
      };
      sock.onmessage = (ev) => {
        try {
          dispatchWsEvent(JSON.parse(ev.data) as SwarmEvent);
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

    void hydrate();
    open();

    return () => {
      cancelled = true;
      isHydrating = false;
      pendingEvents.length = 0;
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