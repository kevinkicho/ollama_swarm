// V2 reducer tests via RunStateObserver. Originally written when the
// observer was parallel-track instrumentation that compared V1↔V2
// phases via checkPhase + getDivergences (2026-04-26). After 7/7 SDK
// presets validated zero divergences (2026-04-27), the divergence
// surface was removed (V2 cutover Phase 1a, 2026-04-28). These tests
// now exercise the reducer directly via apply() + getState() — the
// reducer logic is identical, so the same V1↔V2 agreement scenarios
// are still covered.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunStateObserver } from "./RunStateObserver.js";
import type { RunContext } from "../../../../shared/src/runStateMachine.js";

function makeCtx(overrides: Partial<RunContext> = {}): () => RunContext {
  return () => ({
    openTodos: 0,
    claimedTodos: 0,
    staleTodos: 0,
    auditInvocations: 0,
    maxAuditInvocations: 3,
    currentTier: 0,
    maxTiers: 0,
    allCriteriaResolved: false,
    ...overrides,
  });
}

describe("RunStateObserver — phase transitions", () => {
  it("starts idle", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    assert.equal(obs.getState().phase, "idle");
  });

  it("idle → spawning on start event", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    assert.equal(obs.getState().phase, "spawning");
  });

  it("spawning → planning on spawned event", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    assert.equal(obs.getState().phase, "planning");
  });

  it("planning → executing on todos-posted with count > 0", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 3 });
    assert.equal(obs.getState().phase, "executing");
  });

  it("pause-on-quota sets pausedReason without changing phase (orthogonal)", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 3 });
    obs.apply({ type: "pause-on-quota", ts: 5, reason: "wall" });
    // Phase unchanged; pause is a side marker.
    assert.equal(obs.getState().phase, "executing");
    assert.equal(obs.getState().pausedReason, "wall");
  });

  it("draining state on drain-requested", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 3 });
    obs.apply({ type: "drain-requested", ts: 5 });
    assert.equal(obs.getState().phase, "draining");
  });

  it("stopped on stop-requested from any non-terminal phase", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "stop-requested", ts: 2 });
    assert.equal(obs.getState().phase, "stopped");
  });

  it("failed on fatal-error from any phase", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "fatal-error", ts: 2, message: "x" });
    assert.equal(obs.getState().phase, "failed");
  });

  it("completed via audit cycle: drain → auditing → resolved", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 1 });
    obs.apply({ type: "todo-committed", ts: 5, remainingTodos: 0 });
    assert.equal(obs.getState().phase, "auditing");
    obs.apply({
      type: "auditor-returned",
      ts: 6,
      allCriteriaResolved: true,
      newTodosCount: 0,
    });
    assert.equal(obs.getState().phase, "completed");
  });
});

describe("RunStateObserver — reset", () => {
  it("reset returns state to INITIAL_STATE", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    assert.equal(obs.getState().phase, "planning");
    obs.reset();
    assert.equal(obs.getState().phase, "idle");
  });
});
