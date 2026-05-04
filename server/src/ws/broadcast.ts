import type { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { SwarmEvent } from "../types.js";
import type { EventLogger } from "./eventLogger.js";
import { decideSubscriberAction, type SubscriberAction } from "../swarm/subscriberPausePolicy.js";

export interface SubscriberChange {
  runId: string;
  prevCount: number;
  newCount: number;
  action: SubscriberAction;
  reason: string;
}

export type SubscriberChangeListener = (change: SubscriberChange) => void;

export class Broadcaster {
  // T-Item-MultiTenant Phase 2 (2026-05-04): per-client filter. When
  // `runIdFilter` is set, the client receives ONLY events whose
  // `event.runId === runIdFilter` (plus events with no runId — global
  // events like clone_state aren't routed). When undefined, the
  // client receives ALL events (legacy "all events" behavior; the
  // existing single-page UI uses this).
  private clients = new Map<WebSocket, { runIdFilter?: string }>();
  // R7 wiring (2026-05-04): per-runId subscriber count + a listener
  // hook so callers (orchestrator, transcript appender) can react to
  // "last subscriber dropped" / "first subscriber arrived" events.
  // Empty when no listener is registered → no overhead in the
  // legacy unfiltered path.
  private runIdCounts = new Map<string, number>();
  private subscriberChangeListener?: SubscriberChangeListener;

  // Logger is optional so tests can construct a Broadcaster without touching
  // the filesystem. In prod the server always wires one up.
  constructor(private readonly logger?: EventLogger) {}

  /** R7 wiring: register a listener that fires when a runId's
   *  subscriber count crosses the 0 ↔ N+ boundary. The orchestrator
   *  uses this to decide pause/resume. Caller pre-checks the cfg
   *  flag — Broadcaster fires unconditionally when a listener is
   *  attached. */
  setSubscriberChangeListener(listener: SubscriberChangeListener | undefined): void {
    this.subscriberChangeListener = listener;
  }

  attach(wss: WebSocketServer, onConnect: (ws: WebSocket) => void): void {
    wss.on("connection", (ws, req) => {
      // T-Item-MultiTenant Phase 2: parse `?runId=` from the upgrade
      // URL to set the per-client filter. Bare /ws (no query) → no
      // filter (legacy behavior). Malformed URLs → no filter (fail-
      // open is safe; client just sees all events).
      const filter = parseRunIdFromUpgrade(req);
      this.clients.set(ws, filter ? { runIdFilter: filter } : {});
      if (filter) this.bumpRunIdCount(filter, +1);
      ws.on("close", () => {
        this.clients.delete(ws);
        if (filter) this.bumpRunIdCount(filter, -1);
      });
      ws.on("error", () => {
        this.clients.delete(ws);
        if (filter) this.bumpRunIdCount(filter, -1);
      });
      onConnect(ws);
    });
  }

  /** R7 wiring: adjust the per-runId subscriber count + fire the
   *  listener (if any) on cross-zero transitions. */
  private bumpRunIdCount(runId: string, delta: number): void {
    const prev = this.runIdCounts.get(runId) ?? 0;
    const next = Math.max(0, prev + delta);
    if (next === 0) this.runIdCounts.delete(runId);
    else this.runIdCounts.set(runId, next);
    if (!this.subscriberChangeListener) return;
    // Caller-side pause/resume state is unknown to the broadcaster —
    // pass false defaults; caller can refine if it tracks them.
    const decision = decideSubscriberAction({
      prevCount: prev,
      newCount: next,
      pausedDueToDisconnect: false,
      pausedDueToOther: false,
    });
    this.subscriberChangeListener({
      runId,
      prevCount: prev,
      newCount: next,
      action: decision.action,
      reason: decision.reason,
    });
  }

  /** R7 wiring: read-only access to the current per-runId subscriber
   *  count, for diagnostics + tests. */
  getSubscriberCount(runId: string): number {
    return this.runIdCounts.get(runId) ?? 0;
  }

  // send() is for per-client replay to a newly-connected socket. We do NOT
  // log here — these events were already logged when first broadcast.
  send(ws: WebSocket, event: SwarmEvent): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch (err) {
      this.clients.delete(ws);
      console.error("[ws] send failed:", err instanceof Error ? err.message : err);
    }
  }

  broadcast(event: SwarmEvent): void {
    this.logger?.log(event);
    const payload = JSON.stringify(event);
    for (const [ws, meta] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // T-Item-MultiTenant Phase 2: per-runId filter check. When the
      // client subscribed with ?runId=X, drop events whose runId
      // doesn't match. Events with no runId field (global lifecycle
      // events) ALWAYS pass through — they're not run-specific.
      if (
        meta.runIdFilter !== undefined &&
        event.runId !== undefined &&
        event.runId !== meta.runIdFilter
      ) {
        continue;
      }
      try {
        ws.send(payload);
      } catch (err) {
        this.clients.delete(ws);
        console.error("[ws] broadcast failed:", err instanceof Error ? err.message : err);
      }
    }
  }
}

// T-Item-MultiTenant Phase 2 (2026-05-04): parse the `runId` query
// parameter from a WebSocket upgrade request. Returns null on:
//   - missing `req.url`
//   - malformed URL
//   - missing or empty `runId` query param
// Pure — exported for tests.
export function parseRunIdFromUpgrade(req: IncomingMessage): string | null {
  if (!req.url) return null;
  try {
    // The URL constructor needs an absolute base; the host doesn't
    // matter for query parsing since we only read searchParams.
    const u = new URL(req.url, "http://localhost");
    const id = u.searchParams.get("runId");
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
