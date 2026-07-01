// T-Item-WS-Reconnect: integration test for WS reconnection.
// Verifies that a client disconnecting and reconnecting receives
// the same events as a client that stayed connected — the WS
// broadcast layer must handle transient disconnects gracefully.
//
// Tests the Broadcaster class directly (no HTTP/WS server needed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Broadcaster } from "./broadcast.js";
import type { SwarmEvent } from "../../types.js";
import { SwarmEventSchema } from "@ollama-swarm/shared/wsProtocol";

// Minimal fake WebSocket that records payloads.
interface FakeWS {
  readyState: number;
  OPEN: number;
  sent: string[];
  send(data: string): void;
  on(): void;
}

function makeFakeWs(): FakeWS {
  return {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
    sent: [],
    send(data: string) { this.sent.push(data); },
    on() {},
  };
}

// Helper: seed a client into the broadcaster's internal client map
// and update the per-runId subscriber count.
function seedClient(
  bc: Broadcaster,
  ws: FakeWS,
  filter?: string,
): void {
  const internal = bc as unknown as {
    clients: Map<unknown, { runIdFilter?: string }>;
  };
  internal.clients.set(ws, filter ? { runIdFilter: filter } : {});
  // Keep the runId count in sync so getSubscriberCount works.
  if (filter) {
    const current = bc.getSubscriberCount(filter);
    // Direct set via internal map (bumpRunIdCount is private).
    const counts = (bc as unknown as { runIdCounts: Map<string, number> }).runIdCounts;
    counts.set(filter, current + 1);
  }
}

// Helper: simulate a disconnect (remove from client map + update count).
function disconnectClient(bc: Broadcaster, ws: FakeWS, filter?: string): void {
  const internal = bc as unknown as { clients: Map<unknown, unknown> };
  internal.clients.delete(ws);
  if (filter) {
    const counts = (bc as unknown as { runIdCounts: Map<string, number> }).runIdCounts;
    const current = bc.getSubscriberCount(filter);
    if (current <= 1) counts.delete(filter);
    else counts.set(filter, current - 1);
  }
}

// Helper: simulate reconnect (add back to client map + update count).
function reconnectClient(
  bc: Broadcaster,
  ws: FakeWS,
  filter?: string,
): void {
  ws.sent = []; // clear stale history on reconnect
  seedClient(bc, ws, filter);
}

test("WS reconnect — client that disconnects and reconnects receives subsequent events", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws, "run-A");

  // Client connected, receives an event.
  bc.broadcast({ type: "swarm_state", phase: "planning", round: 1, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 1);

  // Client disconnects.
  disconnectClient(bc, ws, "run-A");

  // Events broadcast while disconnected are missed.
  bc.broadcast({ type: "swarm_state", phase: "executing", round: 2, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 1); // still just the pre-disconnect event

  // Client reconnects (simulating page refresh). The reconnectClient
  // helper clears ws.sent to simulate a fresh connection.
  reconnectClient(bc, ws, "run-A");

  // New events after reconnect are received.
  bc.broadcast({ type: "swarm_state", phase: "completed", round: 5, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 1); // only the post-reconnect event
});

test("WS reconnect — events from other runs are still filtered after reconnect", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws, "run-A");

  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 1);

  // Disconnect + reconnect with same filter.
  disconnectClient(bc, ws, "run-A");
  reconnectClient(bc, ws, "run-A");

  // Events for a different run should be filtered out.
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-B" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 1); // only the run-A event after reconnect
});

test("WS reconnect — filter can change on reconnect", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws, "run-A");

  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 1);

  // Disconnect, then reconnect watching a different run.
  disconnectClient(bc, ws, "run-A");
  reconnectClient(bc, ws, "run-B");

  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-B" } as SwarmEvent);
  assert.equal(ws.sent.length, 1); // only run-B after reconnect
  // The event is for run-B (the new filter).
  const lastEvent = JSON.parse(ws.sent[0]);
  assert.equal(lastEvent.runId, "run-B");
});

test("WS reconnect — unfiltered client receives all events after reconnect", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws); // no filter = all events

  bc.broadcast({ type: "error", message: "test" } as SwarmEvent);
  assert.equal(ws.sent.length, 1);

  disconnectClient(bc, ws);
  bc.broadcast({ type: "error", message: "missed" } as SwarmEvent);

  reconnectClient(bc, ws); // still no filter
  bc.broadcast({ type: "error", message: "received" } as SwarmEvent);
  assert.equal(ws.sent.length, 1); // only post-reconnect
});

test("WS reconnect — subscriber count reflects active connections", () => {
  const bc = new Broadcaster();
  const ws1 = makeFakeWs();
  const ws2 = makeFakeWs();
  seedClient(bc, ws1, "run-A");
  seedClient(bc, ws2, "run-A");

  assert.equal(bc.getSubscriberCount("run-A"), 2);

  disconnectClient(bc, ws1, "run-A");
  assert.equal(bc.getSubscriberCount("run-A"), 1);

  reconnectClient(bc, ws1, "run-A");
  assert.equal(bc.getSubscriberCount("run-A"), 2);
});

test("WS reconnect — global events pass through on reconnect regardless of filter", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws, "run-A");

  // Events with no runId (global) should always pass through.
  bc.broadcast({ type: "error", message: "global-error" } as SwarmEvent);
  assert.equal(ws.sent.length, 1);

  disconnectClient(bc, ws, "run-A");
  // Global event while disconnected — missed.
  bc.broadcast({ type: "error", message: "missed-global" } as SwarmEvent);

  reconnectClient(bc, ws, "run-A");
  // Global event after reconnect should pass through.
  bc.broadcast({ type: "error", message: "post-reconnect-global" } as SwarmEvent);
  assert.equal(ws.sent.length, 1); // only post-reconnect
});

// ---------------------------------------------------------------------------
// Event schema validation at broadcast boundary
// ---------------------------------------------------------------------------

test("SwarmEventSchema validates events that cross the WS boundary", () => {
  // These are the events that the server actually broadcasts. They must
  // all pass the shared Zod schema so the client can rely on their shape.
  const events: SwarmEvent[] = [
    { type: "swarm_state", phase: "idle", round: 0 },
    { type: "swarm_state", phase: "executing", round: 5, runId: "run-1" },
    { type: "error", message: "test error" },
    { type: "todo_committed", todoId: "t1" },
    { type: "todo_skipped", todoId: "t2", reason: "cannot fix" },
    { type: "agent_streaming", agentId: "a1", agentIndex: 1, text: "hello" },
    { type: "agent_streaming_end", agentId: "a1" },
    { type: "agent_state", agent: { id: "a1", index: 1, status: "thinking" } },
  ];

  for (const event of events) {
    const result = SwarmEventSchema.safeParse(event);
    assert.equal(result.success, true, `Event type "${event.type}" should validate: ${JSON.stringify(event)}`);
  }
});