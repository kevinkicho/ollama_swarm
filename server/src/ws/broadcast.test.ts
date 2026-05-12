// T-Item-MultiTenant Phase 2 (2026-05-04): tests for the per-runId WS
// subscriber filter + the URL parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Broadcaster, parseRunIdFromUpgrade } from "./broadcast.js";
import type { IncomingMessage } from "node:http";
import type { SwarmEvent } from "../types.js";

function fakeReq(url: string): IncomingMessage {
  return { url } as unknown as IncomingMessage;
}

test("parseRunIdFromUpgrade — extracts runId from query string", () => {
  assert.equal(parseRunIdFromUpgrade(fakeReq("/ws?runId=abc-123")), "abc-123");
});

test("parseRunIdFromUpgrade — returns null when query missing", () => {
  assert.equal(parseRunIdFromUpgrade(fakeReq("/ws")), null);
});

test("parseRunIdFromUpgrade — returns null when runId param empty", () => {
  assert.equal(parseRunIdFromUpgrade(fakeReq("/ws?runId=")), null);
});

test("parseRunIdFromUpgrade — handles other query params alongside runId", () => {
  assert.equal(
    parseRunIdFromUpgrade(fakeReq("/ws?other=x&runId=abc&z=1")),
    "abc",
  );
});

test("parseRunIdFromUpgrade — null on missing url field", () => {
  assert.equal(parseRunIdFromUpgrade({} as IncomingMessage), null);
});

// Broadcaster filter behavior — minimal fake WebSocket that records
// payloads so we can assert what each subscriber received.

interface FakeWebSocket {
  readyState: number;
  OPEN: number;
  sent: string[];
  send(data: string): void;
  on(): void;
}

function makeFakeWs(): FakeWebSocket {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(data: string) {
      this.sent.push(data);
    },
    on() {
      // ignore — we drive close/error directly via the broadcaster's
      // internal map in tests
    },
  };
}

// Helper: bypass the WS-server attach() and directly seed clients
// into the broadcaster's internal map. We test the filter logic
// independently of the wss connection lifecycle.
function seedClient(
  bc: Broadcaster,
  ws: FakeWebSocket,
  filter?: string,
): void {
  const internal = bc as unknown as {
    clients: Map<unknown, { runIdFilter?: string }>;
  };
  internal.clients.set(ws, filter ? { runIdFilter: filter } : {});
}

test("broadcast — client without filter receives all events", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-1" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-2" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0 } as SwarmEvent);
  assert.equal(ws.sent.length, 3);
});

test("broadcast — client with runId filter only sees matching runId events", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws, "run-A");
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-B" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  assert.equal(ws.sent.length, 2);
  for (const payload of ws.sent) {
    const evt = JSON.parse(payload);
    assert.equal(evt.runId, "run-A");
  }
});

test("broadcast — events with no runId always pass through to filtered clients", () => {
  // Global lifecycle events (clone_state, etc.) shouldn't be hidden
  // from per-run subscribers — they're not run-specific.
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws, "run-A");
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0 } as SwarmEvent);
  assert.equal(ws.sent.length, 1);
});

test("broadcast — multiple clients with different filters get different streams", () => {
  const bc = new Broadcaster();
  const wsA = makeFakeWs();
  const wsB = makeFakeWs();
  const wsAll = makeFakeWs();
  seedClient(bc, wsA, "run-A");
  seedClient(bc, wsB, "run-B");
  seedClient(bc, wsAll); // no filter
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-A" } as SwarmEvent);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0, runId: "run-B" } as SwarmEvent);
  assert.equal(wsA.sent.length, 1);
  assert.equal(wsB.sent.length, 1);
  assert.equal(wsAll.sent.length, 2);
});

test("getRunIdFilter — returns filter for seeded client, undefined for unfiltered", () => {
  const bc = new Broadcaster();
  const wsFiltered = makeFakeWs();
  const wsUnfiltered = makeFakeWs();
  seedClient(bc, wsFiltered, "run-42");
  seedClient(bc, wsUnfiltered);
  assert.equal(bc.getRunIdFilter(wsFiltered as unknown as WebSocket), "run-42");
  assert.equal(bc.getRunIdFilter(wsUnfiltered as unknown as WebSocket), undefined);
});

test("broadcast drops events exceeding MAX_PAYLOAD_BYTES", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws);

  // Create an event large enough to exceed 1MB
  const huge = "x".repeat(1.1 * 1024 * 1024); // ~1.1 MB
  bc.broadcast({ type: "system", text: huge, ts: Date.now() } as unknown as SwarmEvent);
  assert.equal(ws.sent.length, 0, "oversized event should be dropped");
});

test("broadcast still sends events under MAX_PAYLOAD_BYTES", () => {
  const bc = new Broadcaster();
  const ws = makeFakeWs();
  seedClient(bc, ws);
  bc.broadcast({ type: "swarm_state", phase: "idle", round: 0 } as SwarmEvent);
  assert.equal(ws.sent.length, 1, "normal event should pass through");
});
