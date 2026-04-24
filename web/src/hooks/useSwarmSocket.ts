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

function dispatch(ev: SwarmEvent): void {
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
      s.clearStreaming(ev.agentId);
      break;
    case "error":
      s.setError(ev.message);
      break;
    case "board_todo_posted":
      s.upsertTodo(ev.todo);
      break;
    case "board_todo_claimed":
      s.applyClaim(ev.todoId, ev.claim);
      break;
    case "board_todo_committed":
      s.markCommitted(ev.todoId);
      break;
    case "board_todo_stale":
      s.markStale(ev.todoId, ev.reason, ev.replanCount);
      break;
    case "board_todo_skipped":
      s.markSkipped(ev.todoId, ev.reason);
      break;
    case "board_todo_replanned":
      s.applyReplan(ev.todoId, ev.description, ev.expectedFiles, ev.replanCount);
      break;
    case "board_finding_posted":
      s.appendFinding(ev.finding);
      break;
    case "board_state":
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
    case "clone_state":
      s.setCloneState({
        alreadyPresent: ev.alreadyPresent,
        clonePath: ev.clonePath,
        priorCommits: ev.priorCommits,
        priorChangedFiles: ev.priorChangedFiles,
        priorUntrackedFiles: ev.priorUntrackedFiles,
      });
      break;
    case "run_started":
      // Task #37 (partial): a new run is starting. Drop agents/
      // streaming/latency from any prior run in this session — the
      // prior runner's roster is stale (different preset may have
      // more/fewer agents, different ports, different sessions). We
      // keep transcript + findings + board so the user can still
      // scroll through what happened, with a "— new run started —"
      // divider inserted.
      s.resetForNewRun();
      s.setRunStartedAt(ev.startedAt);
      s.setRunId(ev.runId);
      s.setRunConfig({
        preset: ev.preset,
        plannerModel: ev.plannerModel,
        workerModel: ev.workerModel,
        repoUrl: ev.repoUrl,
        clonePath: ev.clonePath,
        agentCount: ev.agentCount,
        rounds: ev.rounds,
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
  } catch {
    // Catch-up is best-effort. WS events still fill in the store as
    // the run progresses — a failed snapshot just means the
    // immediately-post-refresh UI is sparser until the next event.
  }
}

export function useSwarmSocket(): void {
  useEffect(() => {
    void hydrateFromSnapshot();
    connect();
    // No cleanup — the socket is a module-level singleton and is
    // reused across component remounts. The browser cleans it up
    // on page unload.
  }, []);
}
