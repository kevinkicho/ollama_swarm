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
  applyStatusSnapshotToStore,
  buildSyntheticRunStartDivider,
  catchUpEmptyTranscript,
  fetchAndHydrateControlAdviceFromEventLog,
  hasRunStartDivider,
  HYDRATE_MAX_WAIT_MS,
  shouldDropTerminalGuardedEvent,
  statusHasCompletedSummary,
  terminalPhaseFromSummary,
  WS_REPLAY_GRACE_MS,
  type StatusHydrateContext,
} from "./swarmStoreHydrate";
import { apiFetch } from "../lib/apiFetch";

interface SwarmStoreProviderProps {
  /** Run id to subscribe to. */
  runId: string;
  children: ReactNode;
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
    let restHydrateDone = false;
    let wsReplayReady = false;
    let hydrateFinishTimer: ReturnType<typeof setTimeout> | null = null;
    let hydrateMaxTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingEvents: SwarmEvent[] = [];
    const statusCtx: StatusHydrateContext = {
      statusHydrateOk: false,
      statusHasCompletedSummary: false,
    };
    const statusUrl = `/api/swarm/runs/${encodeURIComponent(runId)}/status`;

    const clearHydrateTimers = () => {
      if (hydrateFinishTimer) {
        clearTimeout(hydrateFinishTimer);
        hydrateFinishTimer = null;
      }
      if (hydrateMaxTimer) {
        clearTimeout(hydrateMaxTimer);
        hydrateMaxTimer = null;
      }
    };

    const scheduleHydrateFinish = () => {
      if (hydrateFinishTimer) return;
      hydrateFinishTimer = setTimeout(() => {
        hydrateFinishTimer = null;
        if (!cancelled && isHydrating) finishHydration();
      }, WS_REPLAY_GRACE_MS);
    };

    const tryFinishHydration = () => {
      if (cancelled || !isHydrating) return;
      if (!restHydrateDone || !wsReplayReady) return;
      scheduleHydrateFinish();
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
      if (!isHydrating) return;
      clearHydrateTimers();
      isHydrating = false;
      while (pendingEvents.length > 0) {
        const ev = pendingEvents.shift();
        if (ev) applyWsEvent(ev);
      }
      void catchUpEmptyTranscript(storeRef.current, runId, statusUrl, ctrl.signal);
      void fetchAndHydrateControlAdviceFromEventLog(
        storeRef.current,
        runId,
        ctrl.signal,
      );
    };

    const isFake = runId.startsWith("fake-") || runId.includes("fake");

    const hydrateFromHistoryFallback = async () => {
      const listRes = await apiFetch(`/api/swarm/runs`, { signal: ctrl.signal });
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
      const sumRes = await apiFetch(`/api/swarm/run-summary?${params.toString()}`, {
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
              dedicatedAuditor: summary.runConfig?.dedicatedAuditor,
              topology: summary.runConfig?.topology ?? summary.topology,
              repoUrl: summary.runConfig?.repoUrl,
            },
            "divider-fallback",
          ),
        ]);
      }
      if (summary) s.setSummary(summary);
      if (summary.contract) s.setContract(summary.contract);
      const { hydrateControlAdviceToStore } = await import("./swarmStoreHydrate");
      hydrateControlAdviceToStore(storeRef.current, {
        summaryAdvice: summary.controlAdvice,
        transcript: store.getState().transcript,
      });
      const { hydrateDeliberationToStore } = await import("./swarmStoreHydrate");
      hydrateDeliberationToStore(storeRef.current, summary.deliberation);
      const terminal = terminalPhaseFromSummary(summary);
      if (terminal) {
        s.setPhase(terminal, 0);
        statusCtx.statusHasCompletedSummary = true;
      }
    };

    const hydrate = async () => {
      if (isFake) {
        restHydrateDone = true;
        tryFinishHydration();
        return;
      }
      try {
        const res = await apiFetch(statusUrl, { signal: ctrl.signal });
        if (res.ok) {
          const snap = (await res.json()) as SwarmStatusSnapshot;
          if (cancelled) return;
          statusCtx.statusHydrateOk = true;
          statusCtx.statusHasCompletedSummary = statusHasCompletedSummary(snap);
          applyStatusSnapshotToStore(storeRef.current, runId, snap);
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
        if (!cancelled) {
          restHydrateDone = true;
          tryFinishHydration();
        }
      }
    };

    const open = () => {
      if (cancelled) return;
      const url = wsUrlForRunId(runId);
      const sock = new WebSocket(url);
      socket = sock;
      sock.onopen = () => {
        backoffMs = 500;
        wsReplayReady = true;
        tryFinishHydration();
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
    hydrateMaxTimer = setTimeout(() => {
      if (!cancelled && isHydrating) finishHydration();
    }, HYDRATE_MAX_WAIT_MS);

    return () => {
      cancelled = true;
      isHydrating = false;
      pendingEvents.length = 0;
      clearHydrateTimers();
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