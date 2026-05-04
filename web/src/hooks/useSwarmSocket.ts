import { useContext, useEffect } from "react";
import { useSwarm, SwarmStoreContext } from "../state/store";
import { applyEventToStore } from "../state/applyEvent";
import type { SwarmEvent, SwarmStatusSnapshot } from "../types";

// Singleton so React StrictMode's double-invoked effect doesn't
// open/close a socket mid-handshake (the source of the noisy
// "closed before the connection is established" warning).
let ws: WebSocket | null = null;
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
  applyEvent(ev);
}

function applyEvent(ev: SwarmEvent): void {
  // T-Item-PerRunStore (2026-05-04): dispatch via shared helper so
  // per-run Providers can reuse the same routing logic against
  // their own store. Singleton path keeps targeting the singleton
  // via useSwarm.getState().
  applyEventToStore(ev, useSwarm.getState());
}

function connect(): void {
  if (ws) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.hostname}:${__BACKEND_PORT__}/ws`);
  ws = socket;

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
async function hydrateFromSnapshot(): Promise<void> {
  if (catchUpFetched) return;
  catchUpFetched = true;
  try {
    const res = await fetch("/api/swarm/status");
    if (!res.ok) return;
    const snap = (await res.json()) as SwarmStatusSnapshot;
    const s = useSwarm.getState();
    // Phase + round drive the topbar; safe to set even at idle (no-op).
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
      s.replaceBoard({ todos: snap.board.todos, findings: snap.board.findings });
    }
    if (snap.latency) {
      for (const [agentId, samples] of Object.entries(snap.latency)) {
        for (const sample of samples) s.pushLatencySample(agentId, sample);
      }
    }
    // Task #39: restore mid-stream agent turns from the server-side
    // partial-stream buffer. Without this, Ctrl-R mid-stream lost the
    // partial text entirely — only finalized transcript entries
    // survived. Each entry becomes a setStreaming call so the
    // existing StreamingBubble renders correctly.
    if (snap.streaming) {
      for (const [agentId, entry] of Object.entries(snap.streaming)) {
        s.setStreaming(agentId, entry.text);
      }
    }
    // Phase 2a: hydrate pheromone table from the REST catch-up.
    if (snap.pheromones) {
      for (const [file, state] of Object.entries(snap.pheromones)) {
        s.upsertPheromone(file, state);
      }
    }
    // Phase 2d: hydrate mapper slice assignments.
    if (snap.mapperSlices && Object.keys(snap.mapperSlices).length > 0) {
      s.setMapperSlices(snap.mapperSlices);
    }
  } catch {
    // Catch-up is best-effort. WS events still fill in the store as
    // the run progresses — a failed snapshot just means the
    // immediately-post-refresh UI is sparser until the next event.
  } finally {
    // Task #120: open the gate AFTER snapshot is loaded, then drain
    // any WS events that arrived during the fetch. They're applied
    // in their original arrival order — appendEntry's id-based dedup
    // ensures snapshot entries that overlap with buffered events
    // don't double-insert. Run in finally so a snapshot fetch error
    // still releases the queue (sparser UI is better than wedged UI).
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
  useEffect(() => {
    if (!effectiveEnabled) return;
    void hydrateFromSnapshot();
    connect();
    // No cleanup — the socket is a module-level singleton and is
    // reused across component remounts. The browser cleans it up
    // on page unload.
  }, [effectiveEnabled]);
}
