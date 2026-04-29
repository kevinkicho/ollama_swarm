import { useEffect } from "react";
import { useSwarm } from "../state/store";
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
  const s = useSwarm.getState();
  switch (ev.type) {
    case "transcript_append":
      s.appendEntry(ev.entry);
      break;
    case "agent_state":
      s.upsertAgent(ev.agent);
      break;
    case "swarm_state":
      s.setPhase(ev.phase, ev.round);
      break;
    case "agent_streaming":
      s.setStreaming(ev.agentId, ev.text);
      break;
    case "agent_streaming_end":
      // Task #176 Phase A: don't remove the bubble; mark it "done"
      // so it stays visible (with ✓) until the matching transcript_append
      // arrives and replaces it (or the 30s safety sweeper kicks in).
      s.markStreamingEnded(ev.agentId);
      break;
    case "error":
      s.setError(ev.message);
      break;
    case "todo_posted":
      s.upsertTodo(ev.todo);
      break;
    case "todo_claimed":
      s.applyClaim(ev.todoId, ev.claim);
      break;
    case "todo_committed":
      s.markCommitted(ev.todoId);
      break;
    case "todo_failed":
      s.markStale(ev.todoId, ev.reason, ev.replanCount);
      break;
    case "todo_skipped":
      s.markSkipped(ev.todoId, ev.reason);
      break;
    case "todo_replanned":
      s.applyReplan(
        ev.todoId,
        ev.description,
        ev.expectedFiles,
        ev.replanCount,
        ev.expectedAnchors,
      );
      break;
    case "finding_posted":
      s.appendFinding(ev.finding);
      break;
    case "queue_state":
      s.replaceBoard(ev.snapshot);
      break;
    case "contract_updated":
      s.setContract(ev.contract);
      break;
    case "run_summary":
      s.setSummary(ev.summary);
      break;
    case "agent_latency_sample":
      s.pushLatencySample(ev.agentId, {
        ts: ev.ts,
        elapsedMs: ev.elapsedMs,
        success: ev.success,
        attempt: ev.attempt,
      });
      break;
    case "conformance_sample":
      s.pushConformanceSample({
        ts: ev.ts,
        score: ev.score,
        smoothedScore: ev.smoothedScore,
        ...(ev.reason ? { reason: ev.reason } : {}),
        ...(ev.graderModel ? { graderModel: ev.graderModel } : {}),
        ...(typeof ev.latencyMs === "number" ? { latencyMs: ev.latencyMs } : {}),
        ...(typeof ev.excerptChars === "number" ? { excerptChars: ev.excerptChars } : {}),
        ...(Array.isArray(ev.windowScores) ? { windowScores: ev.windowScores } : {}),
      });
      break;
    case "directive_amended":
      s.pushAmendment({ ts: ev.ts, text: ev.text });
      break;
    case "drift_sample":
      s.pushDriftSample({
        ts: ev.ts,
        similarity: ev.similarity,
        smoothedSimilarity: ev.smoothedSimilarity,
        embeddingModel: ev.embeddingModel,
        excerptChars: ev.excerptChars,
        windowSimilarities: ev.windowSimilarities,
      });
      break;
    case "clone_state":
      s.setCloneState({
        alreadyPresent: ev.alreadyPresent,
        clonePath: ev.clonePath,
        priorCommits: ev.priorCommits,
        priorChangedFiles: ev.priorChangedFiles,
        priorUntrackedFiles: ev.priorUntrackedFiles,
      });
      break;
    case "pheromone_updated":
      // Phase 2a: stigmergy pheromone table update. Live upsert per
      // annotation commit. Full-table hydration happens via the REST
      // catch-up path below.
      s.upsertPheromone(ev.file, ev.state);
      break;
    case "mapper_slices":
      // Phase 2d: map-reduce slice assignments. Emitted once at the
      // top of the run after slicing. Client overwrites the map.
      s.setMapperSlices(ev.slices);
      break;
    case "run_started":
      // Task #37 (partial) + #46: a new run is starting. Drop agents/
      // streaming/latency from any prior run in this session — the
      // prior runner's roster is stale. Transcript + findings + board
      // survive so the user can still scroll through what happened.
      // Task #46 threads the incoming run's metadata into the divider
      // so the Transcript renderer can show a rich block instead of
      // a plain "— new run started —" line.
      s.resetForNewRun({
        runId: ev.runId,
        preset: ev.preset,
        plannerModel: ev.plannerModel,
        workerModel: ev.workerModel,
        agentCount: ev.agentCount,
        repoUrl: ev.repoUrl,
      });
      s.setRunStartedAt(ev.startedAt);
      s.setRunId(ev.runId);
      s.setRunConfig({
        preset: ev.preset,
        plannerModel: ev.plannerModel,
        workerModel: ev.workerModel,
        auditorModel: ev.auditorModel,
        dedicatedAuditor: ev.dedicatedAuditor,
        roles: ev.roles,
        repoUrl: ev.repoUrl,
        clonePath: ev.clonePath,
        agentCount: ev.agentCount,
        rounds: ev.rounds,
        // Phase 4b of #243: thread topology into the store so
        // SwarmView's agentRole/agentModel helpers can use it.
        topology: ev.topology,
      });
      break;
  }
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
export function useSwarmSocket(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    void hydrateFromSnapshot();
    connect();
    // No cleanup — the socket is a module-level singleton and is
    // reused across component remounts. The browser cleans it up
    // on page unload.
  }, [enabled]);
}
