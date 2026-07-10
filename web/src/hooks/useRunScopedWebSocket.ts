// T-Item-MultiTenant Phase 6 (2026-05-04): per-run WS subscription
// hook. Distinct from the legacy `useSwarmSocket` (which is a
// singleton that pipes events into the main `useSwarm` zustand
// store) — this hook opens a NEW socket scoped to one runId and
// hands raw events to a caller-supplied callback. Used by
// multi-tenant aware components (e.g. an ActiveRuns panel that wants
// live phase / round updates for each listed run without polluting
// the main store).
//
// Lifecycle:
//   - mount: opens `/ws?runId=<id>`, callbacks fire as events arrive
//   - runId change: closes prior socket, opens new one
//   - unmount: closes the socket
//   - disconnect: exponential backoff reconnect (500ms..8s)
//
// Cost: one socket per active call site. Cheap; the server's WS
// broadcast just fans out the same payload to N subscribers.

import { useEffect, useRef } from "react";
import type { SwarmEvent } from "../types";
import { swarmWsTokenQuery } from "../lib/apiFetch";

export interface UseRunScopedWebSocketOptions {
  /** Run id to subscribe to. When undefined / empty, the hook is a
   *  no-op (no socket opens). Useful for conditional mounting. */
  runId?: string;
  /** Called once per arriving event. Hook owner decides what to do
   *  with each event (push to a per-run zustand slice, render
   *  inline, etc.). */
  onEvent: (event: SwarmEvent) => void;
  /** Called when the socket transitions states. Optional — useful
   *  for surfacing connection status in the UI. */
  onStateChange?: (state: "connecting" | "open" | "closed") => void;
  /** Light client: requests server-side light topic filtering (?light=1)
   *  so heavy events like full transcript_append / agent_streaming are
   *  dropped or summarized. Great for external monitors / perf. */
  light?: boolean;
}

export function useRunScopedWebSocket(opts: UseRunScopedWebSocketOptions): void {
  // Use refs so changing onEvent / onStateChange between renders
  // doesn't tear down the socket. Only runId changes do.
  const onEventRef = useRef(opts.onEvent);
  const onStateChangeRef = useRef(opts.onStateChange);
  const lightRef = useRef(opts.light);
  useEffect(() => {
    onEventRef.current = opts.onEvent;
    onStateChangeRef.current = opts.onStateChange;
    lightRef.current = opts.light;
  }, [opts.onEvent, opts.onStateChange, opts.light]);

  useEffect(() => {
    const runId = opts.runId?.trim();
    if (!runId) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;
    let cancelled = false;

    const open = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      let url = `${proto}://${location.hostname}:${__BACKEND_PORT__}/ws?runId=${encodeURIComponent(runId)}`;
      if (lightRef.current) url += "&light=1";
      const tq = swarmWsTokenQuery();
      if (tq) url += `&${tq}`;
      onStateChangeRef.current?.("connecting");
      const sock = new WebSocket(url);
      socket = sock;
      sock.onopen = () => {
        backoffMs = 500;
        onStateChangeRef.current?.("open");
      };
      sock.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as SwarmEvent;
          onEventRef.current(parsed);
        } catch {
          // ignore non-JSON
        }
      };
      sock.onclose = () => {
        socket = null;
        onStateChangeRef.current?.("closed");
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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore close errors during teardown
        }
        socket = null;
      }
    };
  }, [opts.runId]);
}
