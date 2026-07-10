// #90 (2026-05-01): tests for the replay reducer. We test the pure
// reduceToSnapshot — the React hook side is exercised by integration
// tests + manual UI sweep (?replay=<runId>).

import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceToSnapshot, diffSnapshots, type ReplayRecord } from "./useReplayState.js";

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

test("reduceToSnapshot — nested agent_state.agent shape (wire format)", () => {
  const snap = reduceToSnapshot([
    rec(0, "agent_state", {
      agent: { id: "agent-1", index: 1, status: "thinking", activityLabel: "standup" },
    }),
  ]);
  assert.equal(snap.agents.length, 1);
  assert.equal(snap.agents[0].id, "agent-1");
  assert.equal(snap.agents[0].status, "thinking");
  assert.equal(snap.agents[0].activityLabel, "standup");
});

test("reduceToSnapshot — agent_activity builds timeline and agent phase", () => {
  const snap = reduceToSnapshot([
    rec(0, "agent_activity", {
      agentId: "agent-1",
      agentIndex: 1,
      phase: "waiting",
      label: "synthesis",
      ts: 1000,
    }),
    rec(1, "agent_activity", {
      agentId: "agent-1",
      agentIndex: 1,
      phase: "streaming",
      label: "synthesis",
      ts: 2000,
    }),
    rec(2, "agent_activity", {
      agentId: "agent-1",
      agentIndex: 1,
      phase: "done",
      ts: 3000,
    }),
  ]);
  assert.equal(snap.activityTimeline.length, 3);
  assert.equal(snap.activityTimeline[0].label, "synthesis");
  assert.equal(snap.activityTimeline[2].phase, "done");
  assert.equal(snap.agents[0].status, "ready");
  assert.equal(snap.agents[0].activityPhase, "done");
});

test("reduceToSnapshot — agents_roster empty clears ghosts", () => {
  const snap = reduceToSnapshot([
    rec(0, "agent_state", { id: "agent-1", index: 1, status: "ready" }),
    rec(1, "agent_state", { id: "agent-3", index: 3, status: "stopped" }),
    rec(2, "agents_roster", { agents: [] }),
  ]);
  assert.equal(snap.agents.length, 0);
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

// #94 deeper (2026-05-01): tests for the extended event coverage + diff.

test("reduceToSnapshot — todo_posted creates an open todo", () => {
  const snap = reduceToSnapshot([
    rec(0, "todo_posted", { id: "t1", description: "Fix the off-by-one" }),
  ]);
  assert.equal(snap.todos.length, 1);
  assert.equal(snap.todos[0].id, "t1");
  assert.equal(snap.todos[0].status, "open");
  assert.equal(snap.todos[0].description, "Fix the off-by-one");
});

test("reduceToSnapshot — todo lifecycle: posted → claimed → committed", () => {
  const snap = reduceToSnapshot([
    rec(0, "todo_posted", { id: "t1", description: "x" }),
    rec(1, "todo_claimed", { id: "t1", workerId: "agent-2" }),
    rec(2, "todo_committed", { id: "t1" }),
  ]);
  assert.equal(snap.todos.length, 1);
  assert.equal(snap.todos[0].status, "committed");
  assert.equal(snap.todos[0].workerId, "agent-2");
});

test("reduceToSnapshot — todo_failed marks stale with reason", () => {
  const snap = reduceToSnapshot([
    rec(0, "todo_posted", { id: "t1" }),
    rec(1, "todo_failed", { id: "t1", reason: "search not found" }),
  ]);
  assert.equal(snap.todos[0].status, "stale");
  assert.equal(snap.todos[0].staleReason, "search not found");
});

test("reduceToSnapshot — todo_skipped marks skipped", () => {
  const snap = reduceToSnapshot([
    rec(0, "todo_posted", { id: "t1" }),
    rec(1, "todo_skipped", { id: "t1" }),
  ]);
  assert.equal(snap.todos[0].status, "skipped");
});

test("reduceToSnapshot — finding_posted accumulates findings", () => {
  const snap = reduceToSnapshot([
    rec(0, "finding_posted", { id: "f1", text: "auth bypass possible" }),
    rec(1, "finding_posted", { id: "f2", text: "race condition" }),
  ]);
  assert.equal(snap.findings.length, 2);
  assert.equal(snap.findings[0].id, "f1");
  assert.equal(snap.findings[1].text, "race condition");
});

test("reduceToSnapshot — contract_updated stores the contract", () => {
  const contract = {
    missionStatement: "ship MoA",
    criteria: [{ description: "tests pass", status: "met" }],
  };
  const snap = reduceToSnapshot([rec(0, "contract_updated", { contract })]);
  assert.deepEqual(snap.contract, contract);
});

test("reduceToSnapshot — directive_amended sets latest directive text", () => {
  const snap = reduceToSnapshot([
    rec(0, "directive_amended", { text: "first amendment" }),
    rec(1, "directive_amended", { text: "second amendment" }),
  ]);
  assert.equal(snap.directive, "second amendment", "latest wins");
});

test("reduceToSnapshot — conformance_sample tracks latest score", () => {
  const snap = reduceToSnapshot([
    rec(0, "conformance_sample", { score: 75 }),
    rec(1, "conformance_sample", { score: 82 }),
  ]);
  assert.equal(snap.conformanceScore, 82);
});

test("reduceToSnapshot — drift_sample tracks latest score (similarity field also accepted)", () => {
  const snap = reduceToSnapshot([
    rec(0, "drift_sample", { similarity: 0.91 }),
    rec(1, "drift_sample", { score: 0.87 }),
  ]);
  assert.equal(snap.driftScore, 0.87);
});

test("reduceToSnapshot — error events accumulate in errors array", () => {
  const snap = reduceToSnapshot([
    rec(0, "error", { message: "Ollama timeout" }),
    rec(1, "error", { message: "git commit failed" }),
  ]);
  assert.equal(snap.errors.length, 2);
  assert.equal(snap.errors[0].message, "Ollama timeout");
});

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

test("diffSnapshots — phase change captured", () => {
  const a = reduceToSnapshot([rec(0, "swarm_state", { phase: "spawning" })]);
  const b = reduceToSnapshot([
    rec(0, "swarm_state", { phase: "spawning" }),
    rec(1, "swarm_state", { phase: "executing" }),
  ]);
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.phaseChanged, { from: "spawning", to: "executing" });
});

test("diffSnapshots — new transcript ids reported", () => {
  const a = reduceToSnapshot([rec(0, "transcript_append", { entry: { id: "e1", role: "agent", text: "x" } })]);
  const b = reduceToSnapshot([
    rec(0, "transcript_append", { entry: { id: "e1", role: "agent", text: "x" } }),
    rec(1, "transcript_append", { entry: { id: "e2", role: "agent", text: "y" } }),
    rec(2, "transcript_append", { entry: { id: "e3", role: "agent", text: "z" } }),
  ]);
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.newTranscriptIds, ["e2", "e3"]);
});

test("diffSnapshots — agent status transitions reported", () => {
  const a = reduceToSnapshot([rec(0, "agent_state", { id: "a1", status: "ready" })]);
  const b = reduceToSnapshot([
    rec(0, "agent_state", { id: "a1", status: "ready" }),
    rec(1, "agent_state", { id: "a1", status: "thinking" }),
  ]);
  const d = diffSnapshots(a, b);
  assert.equal(d.agentStatusChanges.length, 1);
  assert.deepEqual(d.agentStatusChanges[0], { agentId: "a1", from: "ready", to: "thinking" });
});

test("diffSnapshots — todo status transitions reported", () => {
  const a = reduceToSnapshot([rec(0, "todo_posted", { id: "t1" })]);
  const b = reduceToSnapshot([
    rec(0, "todo_posted", { id: "t1" }),
    rec(1, "todo_claimed", { id: "t1", workerId: "w1" }),
  ]);
  const d = diffSnapshots(a, b);
  assert.equal(d.todoStatusChanges.length, 1);
  assert.deepEqual(d.todoStatusChanges[0], { todoId: "t1", from: "open", to: "claimed" });
});

test("diffSnapshots — conformance + drift deltas computed when both present", () => {
  const a = reduceToSnapshot([
    rec(0, "conformance_sample", { score: 70 }),
    rec(1, "drift_sample", { score: 0.85 }),
  ]);
  const b = reduceToSnapshot([
    rec(0, "conformance_sample", { score: 70 }),
    rec(1, "drift_sample", { score: 0.85 }),
    rec(2, "conformance_sample", { score: 78 }),
    rec(3, "drift_sample", { score: 0.92 }),
  ]);
  const d = diffSnapshots(a, b);
  assert.equal(d.conformanceDelta, 8);
  assert.ok(d.driftDelta !== null && Math.abs(d.driftDelta - 0.07) < 0.001);
});

test("diffSnapshots — empty diff when nothing changed", () => {
  const records = [
    rec(0, "swarm_state", { phase: "executing" }),
    rec(1, "agent_state", { id: "a1", status: "ready" }),
  ];
  const a = reduceToSnapshot(records);
  const b = reduceToSnapshot(records);
  const d = diffSnapshots(a, b);
  assert.equal(d.phaseChanged, null);
  assert.equal(d.newTranscriptIds.length, 0);
  assert.equal(d.agentStatusChanges.length, 0);
  assert.equal(d.todoStatusChanges.length, 0);
  assert.equal(d.contractChanged, false);
  assert.equal(d.directiveChanged, false);
});
