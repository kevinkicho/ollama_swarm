// #90 (2026-05-01): tests for the replay reducer. We test the pure
// reduceToSnapshot — the React hook side is exercised by integration
// tests + manual UI sweep (?replay=<runId>).

import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceToSnapshot, type ReplayRecord } from "./useReplayState.js";

const ts = (n: number): number => 1700000000000 + n * 1000;

function rec(n: number, type: string, payload: Record<string, unknown> = {}): ReplayRecord {
  return { ts: ts(n), event: { type, ...payload } };
}

test("reduceToSnapshot — empty input returns idle state", () => {
  const snap = reduceToSnapshot([]);
  assert.equal(snap.runId, null);
  assert.equal(snap.phase, "idle");
  assert.equal(snap.transcript.length, 0);
  assert.equal(snap.agents.length, 0);
  assert.equal(snap.hasSummary, false);
});

test("reduceToSnapshot — run_started populates runId, preset, model, startedAt", () => {
  const snap = reduceToSnapshot([
    rec(0, "run_started", { runId: "r1", preset: "blackboard", plannerModel: "glm-5.1:cloud" }),
  ]);
  assert.equal(snap.runId, "r1");
  assert.equal(snap.preset, "blackboard");
  assert.equal(snap.model, "glm-5.1:cloud");
  assert.equal(snap.startedAt, ts(0));
});

test("reduceToSnapshot — swarm_state updates phase, latest wins", () => {
  const snap = reduceToSnapshot([
    rec(0, "swarm_state", { phase: "spawning" }),
    rec(1, "swarm_state", { phase: "executing" }),
    rec(2, "swarm_state", { phase: "completed" }),
  ]);
  assert.equal(snap.phase, "completed");
});

test("reduceToSnapshot — transcript_append accumulates entries in order", () => {
  const snap = reduceToSnapshot([
    rec(0, "transcript_append", { entry: { id: "e1", role: "system", text: "hello", ts: ts(0) } }),
    rec(1, "transcript_append", { entry: { id: "e2", role: "agent", agentId: "a1", agentIndex: 1, text: "hi", ts: ts(1) } }),
  ]);
  assert.equal(snap.transcript.length, 2);
  assert.equal(snap.transcript[0].id, "e1");
  assert.equal(snap.transcript[0].role, "system");
  assert.equal(snap.transcript[1].id, "e2");
  assert.equal(snap.transcript[1].agentId, "a1");
  assert.equal(snap.transcript[1].agentIndex, 1);
});

test("reduceToSnapshot — transcript_append silently skips malformed entries", () => {
  const snap = reduceToSnapshot([
    rec(0, "transcript_append", {}), // no entry
    rec(1, "transcript_append", { entry: null }),
    rec(2, "transcript_append", { entry: { id: "e1" } }), // missing role
    rec(3, "transcript_append", { entry: { id: "e2", role: "system", text: "ok" } }), // valid
  ]);
  assert.equal(snap.transcript.length, 1);
  assert.equal(snap.transcript[0].id, "e2");
});

test("reduceToSnapshot — agent_state upserts by id, latest fields win", () => {
  const snap = reduceToSnapshot([
    rec(0, "agent_state", { id: "a1", index: 1, status: "spawning" }),
    rec(1, "agent_state", { id: "a2", index: 2, status: "spawning" }),
    rec(2, "agent_state", { id: "a1", status: "ready", port: 8244 }),
    rec(3, "agent_state", { id: "a1", status: "thinking" }),
  ]);
  assert.equal(snap.agents.length, 2);
  // Sorted by index ascending
  assert.equal(snap.agents[0].id, "a1");
  assert.equal(snap.agents[0].status, "thinking", "latest status wins");
  assert.equal(snap.agents[0].port, 8244, "earlier port preserved on later partial update");
  assert.equal(snap.agents[0].index, 1);
  assert.equal(snap.agents[1].id, "a2");
});

test("reduceToSnapshot — run_summary marks terminal + sets finishedAt", () => {
  const snap = reduceToSnapshot([
    rec(0, "run_started", { runId: "r1", preset: "blackboard" }),
    rec(1, "run_summary", { summary: { stopReason: "completed" } }),
  ]);
  assert.equal(snap.hasSummary, true);
  assert.equal(snap.finishedAt, ts(1));
});

test("reduceToSnapshot — unknown event types silently skipped (forward-compat)", () => {
  const snap = reduceToSnapshot([
    rec(0, "run_started", { runId: "r1", preset: "blackboard" }),
    rec(1, "future_event_type_we_dont_handle_yet", { foo: "bar" }),
    rec(2, "swarm_state", { phase: "executing" }),
  ]);
  assert.equal(snap.runId, "r1");
  assert.equal(snap.phase, "executing");
  assert.equal(snap.transcript.length, 0);
});

test("reduceToSnapshot — partial slice produces partial state (the time-travel use case)", () => {
  const records: ReplayRecord[] = [
    rec(0, "run_started", { runId: "r1", preset: "blackboard" }),
    rec(1, "swarm_state", { phase: "spawning" }),
    rec(2, "agent_state", { id: "a1", index: 1, status: "ready" }),
    rec(3, "swarm_state", { phase: "executing" }),
    rec(4, "transcript_append", { entry: { id: "e1", role: "agent", text: "first thought" } }),
    rec(5, "transcript_append", { entry: { id: "e2", role: "agent", text: "second thought" } }),
    rec(6, "swarm_state", { phase: "completed" }),
    rec(7, "run_summary", { summary: {} }),
  ];

  // Tick 0: nothing happened
  assert.equal(reduceToSnapshot(records.slice(0, 0)).phase, "idle");
  // Tick 2: spawning, agent ready
  const t2 = reduceToSnapshot(records.slice(0, 3));
  assert.equal(t2.phase, "spawning");
  assert.equal(t2.agents.length, 1);
  // Tick 5: executing, 2 transcript entries
  const t5 = reduceToSnapshot(records.slice(0, 6));
  assert.equal(t5.phase, "executing");
  assert.equal(t5.transcript.length, 2);
  // Tick 8 (full): completed + summary
  const t8 = reduceToSnapshot(records);
  assert.equal(t8.phase, "completed");
  assert.equal(t8.hasSummary, true);
});

test("reduceToSnapshot — agents sorted by index ascending", () => {
  const snap = reduceToSnapshot([
    rec(0, "agent_state", { id: "a3", index: 3 }),
    rec(1, "agent_state", { id: "a1", index: 1 }),
    rec(2, "agent_state", { id: "a2", index: 2 }),
  ]);
  assert.deepEqual(snap.agents.map((a) => a.id), ["a1", "a2", "a3"]);
});
