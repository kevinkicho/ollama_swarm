// V2 Step 3b tests: parallel-track instrumentation behavior.
// Verifies the observer runs the V2 reducer correctly AND emits
// divergence callbacks when V1 transitions don't match V2's
// derived state.

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

describe("RunStateObserver — happy-path V1↔V2 agreement", () => {
  it("idle V1 ↔ idle V2", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    assert.equal(obs.checkPhase("idle", 0, "init"), true);
    assert.equal(obs.getDivergences().length, 0);
  });

  it("spawning V1 ↔ spawning V2 after start event", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    assert.equal(obs.checkPhase("spawning", 1, "setPhase"), true);
  });

  it("cloning V1 maps to spawning V2 (V2 doesn't model cloning)", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    assert.equal(obs.checkPhase("cloning", 1, "setPhase"), true);
  });

  it("planning V1 ↔ planning V2 after spawned event", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    assert.equal(obs.checkPhase("planning", 2, "setPhase"), true);
  });

  it("executing V1 ↔ executing V2 after todos posted", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 3 });
    assert.equal(obs.checkPhase("executing", 4, "todos-posted"), true);
  });

  it("paused V1 maps to underlying V2 phase (orthogonal)", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 3 });
    obs.apply({ type: "pause-on-quota", ts: 5, reason: "wall" });
    // V2 phase is still executing (pause doesn't change phase)
    assert.equal(obs.getState().phase, "executing");
    assert.equal(obs.getState().pausedReason, "wall");
    // V1 phase is "paused" — should agree (orthogonal mapping)
    assert.equal(obs.checkPhase("paused", 5, "enterPause"), true);
  });

  it("draining V1 ↔ draining V2 on drain-requested", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 3 });
    obs.apply({ type: "drain-requested", ts: 5 });
    assert.equal(obs.checkPhase("draining", 5, "drain"), true);
  });

  it("stopped V1 ↔ stopped V2 on stop-requested", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "stop-requested", ts: 2 });
    assert.equal(obs.checkPhase("stopped", 2, "stop"), true);
  });

  it("stopping V1 maps to stopped V2 (V2 collapses 2-step)", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "stop-requested", ts: 2 });
    assert.equal(obs.checkPhase("stopping", 2, "stop"), true);
  });

  it("failed V1 ↔ failed V2 on fatal-error", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "fatal-error", ts: 2, message: "x" });
    assert.equal(obs.checkPhase("failed", 2, "crash"), true);
  });

  it("completed V1 ↔ completed V2 after audit cycle resolves", () => {
    // Realistic full sequence: drain todos → auditing → auditor returns
    // resolved → completed. The reducer only honors auditor-returned
    // events from the "auditing" phase, so the executing→auditing step
    // (last todo committed with all counts zero) is mandatory.
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
    assert.equal(obs.checkPhase("completed", 6, "auditor"), true);
  });
});

describe("RunStateObserver — divergence detection", () => {
  it("captures + reports divergence when V1 jumps to executing without V2 events", () => {
    const captured: unknown[] = [];
    const obs = new RunStateObserver({
      getCtx: makeCtx(),
      onDivergence: (d) => captured.push(d),
    });
    // V1 phase says executing, but V2 reducer is still idle (no events fired)
    const ok = obs.checkPhase("executing", 100, "phantom-transition");
    assert.equal(ok, false);
    assert.equal(captured.length, 1);
    const d = obs.getDivergences()[0];
    assert.equal(d.v1Phase, "executing");
    assert.equal(d.v2Phase, "idle");
    assert.match(d.expectedV2Phases, /executing/);
    assert.equal(d.trigger, "phantom-transition");
  });

  it("captures wedge — V1 thinks executing but V2 has resolved to completed", () => {
    // Synthetic wedge case: V2 reducer terminates run but V1 phase
    // is still in executing because flag-soup hasn't caught up. The
    // sequence here is a "natural completion": all todos drain →
    // auditor verifies all criteria met → V2 → completed; if V1's
    // setPhase doesn't fire (because one of the V1 flags is still
    // set), this observer catches the divergence.
    const captured: unknown[] = [];
    const obs = new RunStateObserver({
      getCtx: makeCtx(),
      onDivergence: (d) => captured.push(d),
    });
    obs.apply({ type: "start", ts: 1 });
    obs.apply({ type: "spawned", ts: 2, agentCount: 4 });
    obs.apply({ type: "contract-built", ts: 3, criteriaCount: 2 });
    obs.apply({ type: "todos-posted", ts: 4, count: 1 });
    obs.apply({ type: "todo-committed", ts: 5, remainingTodos: 0 });
    obs.apply({
      type: "auditor-returned",
      ts: 6,
      allCriteriaResolved: true,
      newTodosCount: 0,
    });
    assert.equal(obs.getState().phase, "completed");
    // V1 still says executing — that's the wedge bug class
    const ok = obs.checkPhase("executing", 7, "wedge");
    assert.equal(ok, false);
    assert.equal(captured.length, 1);
  });

  it("reset clears state + divergences", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    obs.apply({ type: "start", ts: 1 });
    obs.checkPhase("executing", 1, "test"); // generates divergence
    assert.equal(obs.getDivergences().length, 1);
    obs.reset();
    assert.equal(obs.getDivergences().length, 0);
    assert.equal(obs.getState().phase, "idle");
  });
});

describe("RunStateObserver — onDivergence default no-op", () => {
  it("works without a callback supplied", () => {
    const obs = new RunStateObserver({ getCtx: makeCtx() });
    assert.doesNotThrow(() => obs.checkPhase("executing", 0, "no-cb"));
    assert.equal(obs.getDivergences().length, 1);
  });
});
