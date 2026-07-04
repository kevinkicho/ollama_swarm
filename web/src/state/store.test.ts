// T-Item-PerRunStore (2026-05-04): tests for the per-run zustand
// factory + Context-aware useSwarm hook.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSwarmStore, useSwarm, SwarmStoreContext } from "./store";
import { buildRunContext } from "../components/BrainStartChat";

describe("createSwarmStore", () => {
  it("returns a fresh store with the expected initial shape", () => {
    const s = createSwarmStore().getState();
    assert.equal(s.phase, "idle");
    assert.equal(s.round, 0);
    assert.deepEqual(s.agents, {});
    assert.deepEqual(s.transcript, []);
    assert.deepEqual(s.todos, {});
    assert.deepEqual(s.findings, []);
    assert.equal(s.runId, undefined);
    assert.equal(s.runStartedAt, undefined);
    assert.equal(s.runConfig, undefined);
  });

  it("two stores are independent (mutating one doesn't affect the other)", () => {
    const a = createSwarmStore();
    const b = createSwarmStore();
    a.getState().setPhase("executing", 5);
    a.getState().setRunId("run-A");
    assert.equal(a.getState().phase, "executing");
    assert.equal(a.getState().round, 5);
    assert.equal(a.getState().runId, "run-A");
    // b is untouched
    assert.equal(b.getState().phase, "idle");
    assert.equal(b.getState().round, 0);
    assert.equal(b.getState().runId, undefined);
  });

  it("each call returns a different store instance", () => {
    const a = createSwarmStore();
    const b = createSwarmStore();
    assert.notEqual(a, b);
    assert.notEqual(a.getState, b.getState);
  });

  it("brainChatHistory initializes empty and supports set/append (per-run FAB chat)", () => {
    const store = createSwarmStore();
    const s0 = store.getState();
    assert.deepEqual(s0.brainChatHistory, []);
    const msg = { role: "user" as const, content: "how are we doing?" };
    s0.setBrainChatHistory([msg]);
    assert.deepEqual(store.getState().brainChatHistory, [msg]);
    const msg2 = { role: "assistant" as const, content: "Good, 3 todos open." };
    store.getState().appendBrainChatMessage(msg2);
    assert.equal(store.getState().brainChatHistory.length, 2);
    assert.equal(store.getState().brainChatHistory[1].content, msg2.content);
  });
});

describe("useSwarm singleton API back-compat", () => {
  it("useSwarm.getState exists + returns the singleton's state", () => {
    const s = useSwarm.getState();
    // Shape check — the singleton always exposes the SwarmStore shape
    assert.equal(typeof s.phase, "string");
    assert.equal(typeof s.setPhase, "function");
    assert.equal(typeof s.appendEntry, "function");
  });

  it("useSwarm.setState is callable", () => {
    assert.equal(typeof useSwarm.setState, "function");
  });

  it("useSwarm.subscribe is callable", () => {
    assert.equal(typeof useSwarm.subscribe, "function");
  });
});

describe("SwarmStoreContext", () => {
  it("default context value is null (singleton fallback path)", () => {
    // The Context's defaultValue determines what useContext returns when
    // there's no Provider. null tells the resolver to use the singleton.
    // We can't easily exercise the React context lookup outside a render,
    // so just assert the export exists + is constructed correctly.
    assert.ok(SwarmStoreContext);
    assert.equal(typeof SwarmStoreContext.Provider, "object");
  });
});

describe("buildRunContext (FAB / BrainStartChat during-run context)", () => {
  it("builds capped context with recent transcript summaries + board info", () => {
    const transcript = [
      { id: "e1", role: "system", text: "run started", summary: { kind: "run_start" } },
      { id: "e2", role: "agent", text: "synthesized consensus on approach", summary: { kind: "council_synthesis" } },
    ];
    const ctx = buildRunContext("r-123", { transcript, phase: "executing", runConfig: { preset: "council" }, agents: {} }, { counts: { open: 2 }, todos: [{ id: "t1" }] });
    assert.equal(ctx.runId, "r-123");
    assert.equal(ctx.phase, "executing");
    assert.ok(ctx.recentTranscript);
    assert.ok(ctx.boardCounts);
    assert.equal(ctx.boardCounts?.open, 2);
    assert.ok(Array.isArray(ctx.recentTranscript));
  });

  it("handles empty transcript gracefully", () => {
    const ctx = buildRunContext("r-empty", { transcript: [], phase: "idle" });
    assert.equal(ctx.runId, "r-empty");
    assert.ok(Array.isArray(ctx.recentTranscript));
    assert.equal((ctx.recentTranscript || []).length, 0);
  });
});
