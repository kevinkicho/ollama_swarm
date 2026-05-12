import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SwarmPhaseSchema,
  TodoStatusSchema,
  StopReasonSchema,
  AgentStatusSchema,
  ClaimSchema,
  ExitContractSchema,
  TodoSchema,
  AgentStateSchema,
  SwarmEventSchema,
  validateSwarmEvent,
  DeliverableSchema,
} from "./wsProtocol.js";

// ---------------------------------------------------------------------------
// Schema parsing — valid inputs
// ---------------------------------------------------------------------------

test("SwarmPhaseSchema accepts all 13 phases", () => {
  const phases = [
    "idle", "cloning", "spawning", "seeding", "discussing", "planning",
    "executing", "paused", "draining", "stopping", "stopped", "completed",
    "failed",
  ];
  for (const p of phases) {
    assert.equal(SwarmPhaseSchema.safeParse(p).success, true, p);
  }
  assert.equal(SwarmPhaseSchema.options.length, 13);
});

test("SwarmPhaseSchema rejects invalid phase", () => {
  assert.equal(SwarmPhaseSchema.safeParse("running").success, false);
});

test("TodoStatusSchema accepts all 5 statuses", () => {
  for (const s of ["open", "claimed", "committed", "stale", "skipped"]) {
    assert.equal(TodoStatusSchema.safeParse(s).success, true, s);
  }
});

test("StopReasonSchema accepts all 11 reasons", () => {
  const reasons = [
    "completed", "user", "crash",
    "cap:wall-clock", "cap:commits", "cap:todos", "cap:tokens", "cap:quota",
    "early-stop", "no-progress", "partial-progress",
  ];
  for (const r of reasons) {
    assert.equal(StopReasonSchema.safeParse(r).success, true, r);
  }
});

test("AgentStatusSchema accepts all 7 statuses including killed", () => {
  for (const s of ["spawning", "ready", "thinking", "retrying", "failed", "stopped", "killed"]) {
    assert.equal(AgentStatusSchema.safeParse(s).success, true, s);
  }
});

test("ClaimSchema parses a valid claim", () => {
  const c = ClaimSchema.parse({
    todoId: "t1",
    agentId: "a1",
    fileHashes: { "src/foo.ts": "abc123" },
    claimedAt: 1000,
    expiresAt: 2000,
  });
  assert.equal(c.todoId, "t1");
});

test("ExitContractSchema parses a full contract", () => {
  const c = ExitContractSchema.parse({
    missionStatement: "Build X",
    criteria: [
      { id: "c1", description: "Do Y", expectedFiles: ["src/bar.ts"], status: "unmet", addedAt: 3000 },
    ],
  });
  assert.equal(c.criteria.length, 1);
  assert.equal(c.criteria[0].status, "unmet");
});

test("TodoSchema parses a minimal todo", () => {
  const t = TodoSchema.parse({
    id: "t1",
    description: "Fix bug",
    expectedFiles: ["src/foo.ts"],
    createdBy: "agent-1",
    createdAt: 4000,
    status: "open",
    replanCount: 0,
  });
  assert.equal(t.id, "t1");
  assert.equal(t.status, "open");
});

test("TodoSchema allows optional fields", () => {
  const t = TodoSchema.parse({
    id: "t2",
    description: "Add feature",
    expectedFiles: [],
    createdBy: "agent-2",
    createdAt: 5000,
    status: "claimed",
    replanCount: 1,
    claim: { todoId: "t2", agentId: "a2", fileHashes: {}, claimedAt: 5100, expiresAt: 6000 },
    expectedAnchors: ["anchor-1"],
  });
  assert.equal(t.claim?.agentId, "a2");
  assert.deepEqual(t.expectedAnchors, ["anchor-1"]);
});

test("AgentStateSchema parses a valid agent", () => {
  const a = AgentStateSchema.parse({
    id: "agent-1",
    index: 1,
    status: "thinking",
    thinkingSince: 7000,
  });
  assert.equal(a.id, "agent-1");
  assert.equal(a.status, "thinking");
});

test("DeliverableSchema parses created and modified", () => {
  const c = DeliverableSchema.parse({ path: "src/new.ts", status: "created" });
  assert.equal(c.status, "created");
  const m = DeliverableSchema.parse({ path: "src/old.ts", status: "modified" });
  assert.equal(m.status, "modified");
});

// ---------------------------------------------------------------------------
// SwarmEvent discriminant validation
// ---------------------------------------------------------------------------

test("SwarmEventSchema validates a swarm_state event", () => {
  const result = SwarmEventSchema.safeParse({
    type: "swarm_state",
    phase: "executing",
    round: 3,
  });
  assert.equal(result.success, true);
  if (result.success) {
    const ev = result.data as { type: "swarm_state"; phase: string; round: number };
    assert.equal(ev.phase, "executing");
  }
});

test("SwarmEventSchema validates a todo_posted event", () => {
  const result = SwarmEventSchema.safeParse({
    type: "todo_posted",
    todo: {
      id: "t1",
      description: "Fix bug",
      expectedFiles: ["src/foo.ts"],
      createdBy: "agent-1",
      createdAt: 1000,
      status: "open",
      replanCount: 0,
    },
  });
  assert.equal(result.success, true);
});

test("SwarmEventSchema validates a model_shift event", () => {
  const result = SwarmEventSchema.safeParse({
    type: "model_shift",
    agentId: "agent-1",
    agentIndex: 1,
    fromModel: "model-a",
    toModel: "model-b",
    reason: "failover",
  });
  assert.equal(result.success, true);
});

test("SwarmEventSchema validates a run_started event", () => {
  const result = SwarmEventSchema.safeParse({
    type: "run_started",
    runId: "run-abc",
    startedAt: 1234567890,
    preset: "blackboard",
    plannerModel: "model-p",
    workerModel: "model-w",
    auditorModel: "model-a",
    dedicatedAuditor: true,
    repoUrl: "https://github.com/org/repo",
    clonePath: "/tmp/repo",
    agentCount: 3,
    rounds: 0,
  });
  assert.equal(result.success, true);
});

test("SwarmEventSchema rejects an event with invalid phase", () => {
  const result = SwarmEventSchema.safeParse({
    type: "swarm_state",
    phase: "frobnicating",
    round: 1,
  });
  assert.equal(result.success, false);
});

test("SwarmEventSchema rejects an event missing required fields", () => {
  const result = SwarmEventSchema.safeParse({
    type: "todo_posted",
    // missing `todo`
  });
  assert.equal(result.success, false);
});

test("SwarmEventSchema rejects unknown event type", () => {
  const result = SwarmEventSchema.safeParse({
    type: "unknown_event_type",
    data: "whatever",
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// validateSwarmEvent helper
// ---------------------------------------------------------------------------

test("validateSwarmEvent returns ok:true for valid event", () => {
  const result = validateSwarmEvent({
    type: "error",
    message: "something went wrong",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.type, "error");
  }
});

test("validateSwarmEvent returns ok:false for invalid event", () => {
  const result = validateSwarmEvent({
    type: "swarm_state",
    phase: "INVALID_PHASE",
    round: 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.issues.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Type inference round-trip
// ---------------------------------------------------------------------------

test("z.infer produces matching types for discriminated union", () => {
  // Compile-time check: if this compiles, the discriminate works.
  type Ev = import("./wsProtocol.js").SwarmEvent;
  const e: Ev = { type: "error", message: "test" };
  assert.equal(e.type, "error");
});