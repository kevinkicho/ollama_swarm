// T-Item-4 (2026-05-04): unit tests for AgentManager.killAgent +
// isInFlight. The adaptive worker pool uses these to scale down idle
// workers without orphaning in-flight commit attempts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentManager, type Agent } from "./AgentManager.js";
import type { AgentState, SwarmEvent } from "../types.js";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? "agent-1",
    index: overrides.index ?? 1,
    port: overrides.port ?? 0,
    sessionId: overrides.sessionId ?? "sess-1",
    child: undefined as never, // treeKill tolerates undefined
    model: overrides.model ?? "test-model",
    ...overrides,
  } as Agent;
}

function makeManager(): {
  mgr: AgentManager;
  events: SwarmEvent[];
  states: AgentState[];
} {
  const events: SwarmEvent[] = [];
  const states: AgentState[] = [];
  const mgr = new AgentManager(
    (s) => states.push(s),
    (e) => events.push(e),
    () => {},
  );
  return { mgr, events, states };
}

// Internal-state hatch — TS-only access for setting up agents without
// driving the real spawn path. We only do this in tests.
function injectAgent(mgr: AgentManager, a: Agent): void {
  const internal = mgr as unknown as {
    agents: Map<string, Agent>;
    agentStates: Map<string, AgentState>;
  };
  internal.agents.set(a.id, a);
  internal.agentStates.set(a.id, {
    id: a.id,
    index: a.index,
    port: a.port,
    sessionId: a.sessionId,
    status: "ready",
  });
}

test("isInFlight — false on unknown agent", () => {
  const { mgr } = makeManager();
  assert.equal(mgr.isInFlight("nonexistent"), false);
});

test("isInFlight — false when status=ready", () => {
  const { mgr } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-1" }));
  assert.equal(mgr.isInFlight("a-1"), false);
});

test("isInFlight — true when status=thinking", () => {
  const { mgr } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-2" }));
  mgr.markStatus("a-2", "thinking");
  assert.equal(mgr.isInFlight("a-2"), true);
});

test("markStatus — auto-fills thinkingSince when flipping to thinking", () => {
  const { mgr, states } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-ts" }));
  const before = Date.now();
  mgr.markStatus("a-ts", "thinking");
  const last = states[states.length - 1]!;
  assert.equal(last.status, "thinking");
  assert.ok(last.thinkingSince !== undefined && last.thinkingSince >= before);
  mgr.markStatus("a-ts", "ready");
  const ready = states[states.length - 1]!;
  assert.equal(ready.status, "ready");
  assert.equal(ready.thinkingSince, undefined);
});

test("isInFlight — true when status=retrying", () => {
  const { mgr } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-3" }));
  mgr.markStatus("a-3", "retrying", { retryAttempt: 1, retryMax: 3 });
  assert.equal(mgr.isInFlight("a-3"), true);
});

test("isInFlight — false again after status flips back to ready", () => {
  const { mgr } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-4" }));
  mgr.markStatus("a-4", "thinking");
  assert.equal(mgr.isInFlight("a-4"), true);
  mgr.markStatus("a-4", "ready");
  assert.equal(mgr.isInFlight("a-4"), false);
});

test("killAgent — no-op on unknown id (doesn't throw)", async () => {
  const { mgr } = makeManager();
  await mgr.killAgent("nonexistent");
  // No assertion needed — surviving without throwing is the contract.
});

test("killAgent — removes agent from list + emits status:'killed'", async () => {
  const { mgr, states } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-kill", index: 5 }));
  assert.equal(mgr.list().length, 1);
  await mgr.killAgent("a-kill");
  // Agent removed from list
  assert.equal(mgr.list().length, 0);
  // Last state emission was status: "killed" for the removed agent
  const killedState = states.find(
    (s) => s.id === "a-kill" && s.status === "killed",
  );
  assert.ok(killedState, "expected an agent_state emission with status='killed'");
});

test("killAgent — does not affect other agents", async () => {
  const { mgr } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "victim", index: 2 }));
  injectAgent(mgr, fakeAgent({ id: "survivor", index: 3 }));
  await mgr.killAgent("victim");
  const remaining = mgr.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "survivor");
});

test("beginRunShutdown — aborts sessions and blocks markStatus thinking", async () => {
  const { mgr, events } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-stop", index: 1 }));
  const internal = mgr as unknown as {
    sessions: Map<string, { abortController: AbortController }>;
  };
  const session = { abortController: new AbortController() };
  internal.sessions.set("sess-stop", session as never);
  mgr.beginRunShutdown();
  assert.equal(session.abortController.signal.aborted, true);
  mgr.markStatus("a-stop", "thinking");
  assert.equal(mgr.isInFlight("a-stop"), false);
  const streaming = events.filter((e) => e.type === "agent_streaming");
  assert.equal(streaming.length, 0);
});

test("killAll — aborts provider session controllers", async () => {
  const { mgr } = makeManager();
  const agent = fakeAgent({ id: "a-abort", sessionId: "sess-abort" });
  injectAgent(mgr, agent);
  const internal = mgr as unknown as {
    sessions: Map<string, { abortController: AbortController }>;
  };
  const session = { abortController: new AbortController() };
  internal.sessions.set("sess-abort", session as never);
  await mgr.killAll();
  assert.equal(session.abortController.signal.aborted, true);
});

test("killAgent — clears mirrored agentState (subsequent isInFlight returns false)", async () => {
  const { mgr } = makeManager();
  injectAgent(mgr, fakeAgent({ id: "a-x" }));
  mgr.markStatus("a-x", "thinking");
  assert.equal(mgr.isInFlight("a-x"), true);
  await mgr.killAgent("a-x");
  assert.equal(mgr.isInFlight("a-x"), false);
});
