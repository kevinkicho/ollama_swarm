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
import { wsUrlForRunId } from "../hooks/useSwarmSocket";

interface SwarmStoreProviderProps {
  /** Run id to subscribe to. */
  runId: string;
  children: ReactNode;
}

export function SwarmStoreProvider({ runId, children }: SwarmStoreProviderProps) {
  // Create a fresh store ONCE per runId. useMemo with [runId] dep
  // means switching runIds tears down + recreates.
  // Pre-set to avoid flash to SetupForm on first render of a /runs/:id view.
  // With aggressive root guard removal, we rely less on these hacks; the per-run store + hydrate now drives correct display.
  const store = useMemo<StoreApi<SwarmStore>>(() => {
    const newStore = createSwarmStore();
    newStore.setState((state) => ({
      ...state,
      runId,
      phase: 'spawning',
    }));
    return newStore;
  }, [runId]);

  // Refs hold the latest store so socket callbacks don't capture
  // stale references across React StrictMode double-invokes.
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

    const isFake = runId.startsWith('fake-') || runId.includes('fake');

    // Hydrate from REST snapshot first so the store is non-empty
    // before the live socket starts streaming. Best-effort — a
    // failed snapshot just means the UI is sparser until events
    // start landing. Skip network request for fake review entries.
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
          const s = storeRef.current.getState();
          // Set phase from snap (server's statusForRun now corrects terminal phase
          // using summary.stopReason so snap is authoritative for both live and finished).
          if (snap.phase != null) {
            s.setPhase(snap.phase as any, (snap as any).round ?? 0);
          }
          // For live runs, upsert agents from snap so sidebar populates immediately (even before WS events).
          // For history/finished, rely on SidebarSummaryAgents.
          const hasSnapCompleted = !!(snap.summary && snap.summary.stopReason != null);
          if (snap.agents && Array.isArray(snap.agents) && !hasSnapCompleted) {
            snap.agents.forEach((a: any) => {
              const idx = a.index ?? a.agentIndex ?? 0;
              const id = a.id || a.agentId || `agent-${idx}`;
              s.upsertAgent({ id, index: idx, status: a.status || "ready", model: a.model } as any);
            });
          }
          if (snap.runConfig) {
            const rc = { ...snap.runConfig };
            s.setRunConfig(rc);
          }
          for (const e of snap.transcript) s.appendEntry(e);
          // Ensure start run message (divider) is present and at the very top even on reload/live runs.
          // Handle races where WS deliveries interleave with /status hydrate (divider may land not at [0]).
          let currentTx = storeRef.current.getState().transcript || [];
          const hasDiv = currentTx.some((t: any) => t.text && t.text.startsWith("▸▸RUN-START▸▸"));
          if (hasDiv) {
            const dIdx = currentTx.findIndex((t: any) => t.text && t.text.startsWith("▸▸RUN-START▸▸"));
            if (dIdx > 0) {
              const d = currentTx[dIdx];
              currentTx = [d, ...currentTx.filter((_: any, i: number) => i !== dIdx)];
              storeRef.current.setState({ transcript: currentTx });
            }
          } else if (!currentTx.length || !currentTx[0]?.text?.startsWith("▸▸RUN-START▸▸")) {
            const divider = {
              id: `divider-hydrate-${Date.now()}`,
              role: "system" as const,
              text: `▸▸RUN-START▸▸|runId=${runId}|preset=${(snap as any).preset || snap.runConfig?.preset || ''}|plannerModel=${snap.runConfig?.plannerModel || ''}|workerModel=${snap.runConfig?.workerModel || ''}|agentCount=${snap.runConfig?.agentCount || ''}|repoUrl=${snap.runConfig?.repoUrl || ''}`,
              ts: Date.now(),
            };
            storeRef.current.setState({ transcript: [divider, ...currentTx] });
          }
          if (snap.summary) s.setSummary(snap.summary);
          if (snap.contract) s.setContract(snap.contract);
          if (snap.cloneState) s.setCloneState(snap.cloneState);
          if (snap.runConfig) {
            const rc = { ...snap.runConfig };
            // Phase 10: no special phase merging. Use as-is.
            s.setRunConfig(rc);
          }
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
        }
      } catch {
        // best-effort
      }

      const hadTranscriptFromStatus = storeRef.current.getState().transcript.length > 0;

      // Fallback for past runs where /status 404s (no runPaths entry for snapshot):
      // discover the clonePath via broad /runs list, then load run-summary
      // (which has the transcript/summary for completed runs).
      if (!cancelled) {
        try {
          const listRes = await fetch(`/api/swarm/runs`, { signal: ctrl.signal });
          if (listRes.ok) {
            const listBody = await listRes.json();
            const match = (listBody.runs || []).find((r: any) => r.runId === runId || (runId && (r.runId.startsWith(runId) || runId.startsWith(r.runId))));
            const s = storeRef.current.getState();
            s.setRunId(runId);
            if (match && match.clonePath) {
              const params = new URLSearchParams({ clonePath: match.clonePath, runId });
              const sumRes = await fetch(`/api/swarm/run-summary?${params.toString()}`, { signal: ctrl.signal });
              if (sumRes.ok) {
                const summary = await sumRes.json();
                const cp = summary.localPath || match.clonePath;
                if (cp) {
                  const srcCfg = (summary as any).runConfig || summary;
                  const prevCfg = s.runConfig || {};
                  s.setRunConfig({
                    ...prevCfg,
                    clonePath: cp,
                    preset: summary.preset || match.preset,
                    model: summary.model || match.model,
                  } as any);
                }
                if (summary.startedAt) s.setRunStartedAt(summary.startedAt);
                if (summary.transcript) {
                  // Always attempt to merge from /run-summary (the main aggregated for pipeline runs).
                  // id-based dedup in appendEntry will skip exact dups; extra/more-complete
                  // entries (e.g. from final Pipeline write vs partial status synthesis) will be added.
                  // This ensures review/history gets the full agent bubbles + final run summary.
                  for (const e of summary.transcript) s.appendEntry(e);
                }
                // Ensure divider in fallback path too (for cases where /status didn't provide or failed).
                let currentTx2 = storeRef.current.getState().transcript || [];
                const hasDiv2 = currentTx2.some((t: any) => t.text && t.text.startsWith("▸▸RUN-START▸▸"));
                if (hasDiv2) {
                  const dIdx = currentTx2.findIndex((t: any) => t.text && t.text.startsWith("▸▸RUN-START▸▸"));
                  if (dIdx > 0) {
                    const d = currentTx2[dIdx];
                    currentTx2 = [d, ...currentTx2.filter((_: any, i: number) => i !== dIdx)];
                    storeRef.current.setState({ transcript: currentTx2 });
                  }
                } else if (!currentTx2.length || !currentTx2[0]?.text?.startsWith("▸▸RUN-START▸▸")) {
                  const divider = {
                    id: `divider-fallback-${Date.now()}`,
                    role: "system" as const,
                    text: `▸▸RUN-START▸▸|runId=${runId}|preset=${summary.preset || (match as any)?.preset || ''}|plannerModel=${summary.runConfig?.plannerModel || ''}|workerModel=${summary.runConfig?.workerModel || ''}|agentCount=${summary.runConfig?.agentCount || ''}|repoUrl=${summary.runConfig?.repoUrl || ''}`,
                    ts: Date.now(),
                  };
                  storeRef.current.setState({ transcript: [divider, ...currentTx2] });
                }
                if (summary) s.setSummary(summary);
                if (summary.contract) s.setContract(summary.contract);
                // Authoritative terminal phase from summary (stopReason)
                if (summary.stopReason) {
                  const phase = summary.stopReason === "completed" ? "completed"
                    : summary.stopReason === "user" || summary.stopReason === "crash" ? "stopped"
                    : summary.stopReason === "no-progress" || summary.stopReason === "partial-progress" ? "stopped"
                    : "stopped";
                  s.setPhase(phase as any, 0);
                } else if (summary.endedAt != null || (summary as any).wallClockMs != null || summary.stopReason != null) {
                  s.setPhase("stopped", 0);
                }
              } else {
                // Even if run-summary 404s or fails, since the run appeared in /runs list (user selected it),
                // treat as finished so we don't kick back to setup form.
                s.setPhase("stopped", 0);
              }
            } else {
              // Run in list but no clonePath match? Still mark stopped to avoid reset.
              s.setPhase("stopped", 0);
            }
          } else {
            // /runs list failed but we have runId from route — mark stopped.
            const s = storeRef.current.getState();
            s.setRunId(runId);
            s.setPhase("stopped", 0);
          }
        } catch {
          // best effort — at least set the runId and terminal phase so we don't reset to setup.
          const s = storeRef.current.getState();
          s.setRunId(runId);
          s.setPhase("stopped", 0);
        }
      }
    };
    void hydrate();

    const open = () => {
      if (cancelled) return;
      // Reuse the same WS URL builder as the main socket hook. This ensures the
      // per-run scoped WS (for /runs/:id views) connects to the correct backend
      // (using __BACKEND_PORT__ in dev, where vite may serve the page on a different port).
      const url = wsUrlForRunId(runId);
      const sock = new WebSocket(url);
      socket = sock;
      sock.onopen = () => {
        backoffMs = 500;
      };
      sock.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as SwarmEvent;
          const st = storeRef.current.getState();
          const isTerminalPhase = st.phase === "stopped" || st.phase === "completed" || st.phase === "failed";
          const hasCompletedSummary = !!(st.summary && st.summary.stopReason != null);
          // Guard for history/completed /runs/:id review:
          // - Skip agent_state to prevent populating store.agents (which would make agentList.length > 0
          //   and switch sidebar away from the desired SidebarSummaryAgents "FINAL AGENT STATS" detailed view).
          // - Skip swarm_state to keep the phase from the REST summary (don't let WS override it).
          // This is only for terminal/history contexts. Live runs (non-terminal, no completed summary)
          // still receive agent_state/swarm_state for live updates.
          if ((parsed.type === "agent_state" || parsed.type === "swarm_state") &&
              ( isTerminalPhase || hasCompletedSummary )) {
            return;
          }
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
