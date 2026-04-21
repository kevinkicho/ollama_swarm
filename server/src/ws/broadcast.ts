import type { WebSocket, WebSocketServer } from "ws";
import type { SwarmEvent } from "../types.js";
import type { EventLogger } from "./eventLogger.js";

export class Broadcaster {
  private clients = new Set<WebSocket>();

  // Logger is optional so tests can construct a Broadcaster without touching
  // the filesystem. In prod the server always wires one up.
  constructor(private readonly logger?: EventLogger) {}

  attach(wss: WebSocketServer, onConnect: (ws: WebSocket) => void): void {
    wss.on("connection", (ws) => {
      this.clients.add(ws);
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
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(payload);
      } catch (err) {
        this.clients.delete(ws);
        console.error("[ws] broadcast failed:", err instanceof Error ? err.message : err);
      }
    }
  }
}
