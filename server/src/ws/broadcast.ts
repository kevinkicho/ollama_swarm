import type { WebSocket, WebSocketServer } from "ws";
import type { SwarmEvent } from "../types.js";

export class Broadcaster {
  private clients = new Set<WebSocket>();

  attach(wss: WebSocketServer, onConnect: (ws: WebSocket) => void): void {
    wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
      onConnect(ws);
    });
  }

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
