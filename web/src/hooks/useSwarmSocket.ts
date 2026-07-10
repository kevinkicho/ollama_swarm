import { useContext, useEffect } from "react";
import { useSwarm, SwarmStoreContext, swarmSingletonStore } from "../state/store";
import { applyEventToStore } from "../state/applyEvent";
import type { SwarmEvent, SwarmStatusSnapshot } from "../types";
import {
  applyStatusSnapshotToStore,
  catchUpEmptyTranscript,
  HYDRATE_MAX_WAIT_MS,
  WS_REPLAY_GRACE_MS,
} from "../state/swarmStoreHydrate";
import { apiFetch, swarmWsTokenQuery } from "../lib/apiFetch";

// Legacy singleton WS hook for the primary SwarmStore. Per-run views
// should filter by runId on the client (or use a run-scoped socket) when
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
let restHydrateDone = false;
let wsReplayReady = false;
let hydrateFinishTimer: ReturnType<typeof setTimeout> | null = null;
let hydrateMaxTimer: ReturnType<typeof setTimeout> | null = null;
const pendingEvents: SwarmEvent[] = [];

function runIdFromPathname(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname.match(/^\/runs\/([^/]+)/)?.[1];
}

function clearHydrateTimers(): void {
  if (hydrateFinishTimer) {
    clearTimeout(hydrateFinishTimer);
    hydrateFinishTimer = null;
  }
  if (hydrateMaxTimer) {
    clearTimeout(hydrateMaxTimer);
    hydrateMaxTimer = null;
  }
}

function finishHydrationSingleton(): void {
  if (!isHydrating) return;
  clearHydrateTimers();
  isHydrating = false;
  while (pendingEvents.length > 0) {
    const next = pendingEvents.shift();
    if (next) applyEvent(next);
  }
  const runId = useSwarm.getState().runId ?? runIdFromPathname();
  if (runId) {
    void catchUpEmptyTranscript(swarmSingletonStore, runId, statusUrlForRunId(runId));
  }
}

function scheduleHydrateFinish(): void {
  if (hydrateFinishTimer) return;
  hydrateFinishTimer = setTimeout(() => {
    hydrateFinishTimer = null;
    finishHydrationSingleton();
  }, WS_REPLAY_GRACE_MS);
}

function tryFinishHydrationSingleton(): void {
  if (!isHydrating) return;
  if (!restHydrateDone || !wsReplayReady) return;
  scheduleHydrateFinish();
}

function dispatch(ev: SwarmEvent): void {
  if (isHydrating) {
    pendingEvents.push(ev);
    return;
  }
  // Throttle high-frequency streaming updates per agent (~20fps). A single
  // global clock starved multi-agent streams (only one agent updated per 50ms).
  if (ev.type === "agent_streaming") {
    const agentId = (ev as { agentId?: string }).agentId ?? "global";
    const now = Date.now();
    const map = ((dispatch as unknown as { _lastStreamByAgent?: Map<string, number> })
      ._lastStreamByAgent ??= new Map<string, number>());
    const last = map.get(agentId) ?? 0;
    if (now - last < 50) return;
    map.set(agentId, now);
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
    url += (url.includes("?") ? "&" : "?") + "light=1";
  }
  const tq = swarmWsTokenQuery();
  if (tq) url += (url.includes("?") ? "&" : "?") + tq;
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
    wsReplayReady = true;
    tryFinishHydrationSingleton();
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
  isHydrating = true;
  restHydrateDone = false;
  wsReplayReady = false;
  clearHydrateTimers();
  hydrateMaxTimer = setTimeout(() => finishHydrationSingleton(), HYDRATE_MAX_WAIT_MS);

  const pathRunId = runIdFromPathname();
  const isRoot = typeof window !== "undefined" && window.location.pathname === "/";
  const current = useSwarm.getState();
  if (isRoot && !pathRunId && (!current.runId || current.phase === "idle")) {
    restHydrateDone = true;
    wsReplayReady = true;
    finishHydrationSingleton();
    return;
  }

  const runId = current.runId ?? pathRunId;
  try {
    const res = await apiFetch(statusUrlForRunId(runId));
    if (!res.ok) return;
    const snap = (await res.json()) as SwarmStatusSnapshot;

    if (typeof window !== "undefined" && window.location.pathname === "/" && !pathRunId && !useSwarm.getState().runId) {
      return;
    }

    const effectiveRunId = snap.runId ?? runId ?? "unknown";
    applyStatusSnapshotToStore(swarmSingletonStore, effectiveRunId, snap);
  } catch {
    // best-effort
  } finally {
    restHydrateDone = true;
    tryFinishHydrationSingleton();
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
