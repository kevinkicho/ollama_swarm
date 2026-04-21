import { useEffect } from "react";
import { useSwarm } from "../state/store";
import type { SwarmEvent } from "../types";

// Singleton so React StrictMode's double-invoked effect doesn't
// open/close a socket mid-handshake (the source of the noisy
// "closed before the connection is established" warning).
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 500;

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

export function useSwarmSocket(): void {
  useEffect(() => {
    connect();
    // No cleanup — the socket is a module-level singleton and is
    // reused across component remounts. The browser cleans it up
    // on page unload.
  }, []);
}
