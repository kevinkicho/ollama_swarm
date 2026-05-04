import type { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { SwarmEvent } from "../types.js";
import type { EventLogger } from "./eventLogger.js";

export class Broadcaster {
  // T-Item-MultiTenant Phase 2 (2026-05-04): per-client filter. When
  // `runIdFilter` is set, the client receives ONLY events whose
  // `event.runId === runIdFilter` (plus events with no runId — global
  // events like clone_state aren't routed). When undefined, the
  // client receives ALL events (legacy "all events" behavior; the
  // existing single-page UI uses this).
  private clients = new Map<WebSocket, { runIdFilter?: string }>();

  // Logger is optional so tests can construct a Broadcaster without touching
  // the filesystem. In prod the server always wires one up.
  constructor(private readonly logger?: EventLogger) {}

  attach(wss: WebSocketServer, onConnect: (ws: WebSocket) => void): void {
    wss.on("connection", (ws, req) => {
      // T-Item-MultiTenant Phase 2: parse `?runId=` from the upgrade
      // URL to set the per-client filter. Bare /ws (no query) → no
      // filter (legacy behavior). Malformed URLs → no filter (fail-
      // open is safe; client just sees all events).
      const filter = parseRunIdFromUpgrade(req);
      this.clients.set(ws, filter ? { runIdFilter: filter } : {});
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
      onConnect(ws);
    });
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
