import { useContext, useEffect } from "react";
import { useSwarm, SwarmStoreContext } from "../state/store";
import { applyEventToStore } from "../state/applyEvent";
import type { SwarmEvent, SwarmStatusSnapshot } from "../types";

// Legacy singleton WS hook for the primary SwarmStore. Per-run views
// should prefer `useRunScopedWebSocket` to avoid mixing events when
// multiple runs are active. This hook already scopes by store.runId.
//
// Singleton so React StrictMode's double-invoked effect doesn't
// open/close a socket mid-handshake (the source of the noisy
// "closed before the connection is established" warning).
let ws: WebSocket | null = null;
/** runId the current socket was opened for (undefined = unfiltered). */
let wsRunId: string | undefined = undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 500;
// Unit 62: gate the page-refresh catch-up fetch so React StrictMode's
// double-mount doesn't pull /api/swarm/status twice on initial load.
// (The fetch is idempotent, so a duplicate isn't harmful — just
// wasteful and noisy in the network tab.)
let catchUpFetched = false;

// Task #120: hard-refresh transcript hydration race. Before this fix,
// `hydrateFromSnapshot()` was kicked off (async fetch) immediately
// followed by `connect()` (sync WS open). The WS could begin emitting
// `transcript_append` events for entries N+1, N+2 BEFORE the fetch
// resolved with entries 1..N. Those new events went into the empty
// transcript first, then the snapshot loop appended 1..N behind them
// (dedup'd correctly but in WRONG ORDER). Result: user saw newer
// entries above older ones, sometimes appearing as "missing
// transcript history."
//
// Fix: buffer WS events while hydration is in progress, drain in
// arrival order once hydration completes. Setting `isHydrating=false`
// is the gate; `pendingEvents` is the queue.
let isHydrating = true;
const pendingEvents: SwarmEvent[] = [];

function dispatch(ev: SwarmEvent): void {
  if (isHydrating) {
    pendingEvents.push(ev);
    return;
  }
  // Throttle high-frequency streaming updates to reduce store churn / re-renders
  if (ev.type === 'agent_streaming') {
    const key = `stream-${(ev as any).agentId || 'global'}`;
    const now = Date.now();
    if ((dispatch as any)._lastStream && now - (dispatch as any)._lastStream < 50) return; // ~20fps
    (dispatch as any)._lastStream = now;
  }
  applyEvent(ev);
}

function applyEvent(ev: SwarmEvent): void {
  // T-Item-PerRunStore (2026-05-04): dispatch via shared helper so
  // per-run Providers can reuse the same routing logic against
  // their own store. Singleton path keeps targeting the singleton
  // via useSwarm.getState().
  applyEventToStore(ev, useSwarm.getState());
}

export function wsUrlForRunId(runId: string | undefined, light = false): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let url = runId
    ? `${proto}://${location.hostname}:${__BACKEND_PORT__}/ws?runId=${encodeURIComponent(runId)}`
    : `${proto}://${location.hostname}:${__BACKEND_PORT__}/ws`;
  if (light) {
    url += (url.includes('?') ? '&' : '?') + 'light=1';
  }
  return url;
}

function connect(): void {
  // T-Item-MultiTenant: filter WS events by current runId so concurrent
  // runs on the same server don't mix events in the UI.
  const runId = useSwarm.getState().runId;
  // React StrictMode double-mounts effects. Reuse an in-flight socket
  // when the runId hasn't changed — closing here was the source of the
  // noisy "closed before the connection is established" warning.
  if (
    ws &&
    wsRunId === runId &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore close errors during reconnect
    }
    ws = null;
  }
  const socket = new WebSocket(wsUrlForRunId(runId, /* light: for topic-filtered light clients set true e.g. monitoring */ false));
  ws = socket;
  wsRunId = runId;

  socket.onopen = () => {
    backoffMs = 500;
  };
  socket.onmessage = (ev) => {
    try {
      dispatch(JSON.parse(ev.data) as SwarmEvent);
    } catch {
      // ignore non-JSON
    }
  };
  socket.onclose = () => {
    ws = null;
    const delay = Math.min(backoffMs, 8000);
    backoffMs = Math.min(backoffMs * 2, 8000);
    reconnectTimer = setTimeout(connect, delay);
  };
  socket.onerror = () => {
    socket.close();
  };
}

// Unit 62: page-refresh catch-up. Runs once per page load BEFORE the
// WS opens its first event, so the store hydrates from the snapshot
// and live events layer on top. If a run is in flight when the user
// hits Ctrl-R, this restores the board / clone banner / runtime
// ticker / latency sparkline without waiting for the next event tick
// (which on a slow run could be minutes away).
function statusUrlForRunId(runId: string | undefined): string {
  return runId
    ? `/api/swarm/runs/${encodeURIComponent(runId)}/status`
    : "/api/swarm/status";
}

async function hydrateFromSnapshot(): Promise<void> {
  if (catchUpFetched) return;
  catchUpFetched = true;

  // HARD GUARD against the recurring "stale run state on root" race.
  // On pure root path we must never hydrate a run-specific snapshot into
  // the singleton. This is the exact same pattern that caused the agents
  // sidebar to flash from fallback → cards, and the "empty blackboard run"
  // view on /.  We check both the URL and the current store shape.
  const isRoot = typeof window !== 'undefined' && window.location.pathname === '/';
  const current = useSwarm.getState();
  if (isRoot && (!current.runId || current.phase === 'idle')) {
    // Clean setup mode – do not pull any run data.
    isHydrating = false;
    return;
  }

  try {
    const runId = useSwarm.getState().runId;
    const res = await fetch(statusUrlForRunId(runId));
    if (!res.ok) return;
    const snap = (await res.json()) as SwarmStatusSnapshot;

    // Re-check after fetch in case we navigated or reset during the request.
    if (typeof window !== 'undefined' && window.location.pathname === '/' && !useSwarm.getState().runId) {
      isHydrating = false;
      return;
    }

    const s = useSwarm.getState();
    s.setPhase(snap.phase, snap.round);
    for (const a of snap.agents) s.upsertAgent(a);
    if (snap.transcript?.length) s.hydrateTranscriptEntries(snap.transcript);
    if (snap.summary) s.setSummary(snap.summary);
    if (snap.contract) s.setContract(snap.contract);
    if (snap.cloneState) s.setCloneState(snap.cloneState);
    if (snap.runConfig) s.setRunConfig(snap.runConfig);
    if (snap.runId) s.setRunId(snap.runId);
    if (snap.runStartedAt) s.setRunStartedAt(snap.runStartedAt);
    if (snap.board) {
      s.replaceBoard({ todos: snap.board.todos, findings: snap.board.findings });
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
  } catch {
    // best-effort
  } finally {
    isHydrating = false;
    while (pendingEvents.length > 0) {
      const next = pendingEvents.shift();
      if (next) applyEvent(next);
    }
  }
}

// Task #65: `enabled=false` keeps the hook a no-op so review-tabs
// (?review=...) skip the live WebSocket + status snapshot fetch
// — the review view hydrates the store from a saved summary instead.
//
// T-Item-PerRunStore (2026-05-04): also no-op when a SwarmStoreContext
// Provider is active. The per-run Provider opens its OWN per-runId
// WS subscription + REST hydration; the singleton socket would
// duplicate events into the singleton store the per-run subtree
// isn't reading from.
export function useSwarmSocket(enabled = true): void {
  const perRunStore = useContext(SwarmStoreContext);
  const effectiveEnabled = enabled && perRunStore === null;
  const runId = useSwarm((s) => s.runId);
  useEffect(() => {
    if (!effectiveEnabled) return;
    void hydrateFromSnapshot();
    // connect() reconnects only when runId changes or the prior socket
    // is no longer open/connecting — safe under StrictMode double-mount.
    connect();
    // No cleanup — the socket is a module-level singleton and is
    // reused across component remounts. The browser cleans it up
    // on page unload.
  }, [effectiveEnabled, runId]);
}
