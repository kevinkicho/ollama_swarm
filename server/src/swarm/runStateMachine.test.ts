// V2 Step 3a tests: pure-reducer state-machine semantics. Lives in
// server/ for the existing node:test harness. Imports from shared/ via
// relative path (the existing pattern — see server/src/types.ts:12 and
// server/src/swarm/extractJson.ts:7). Workspace-resolved imports would
// trigger npm install on /mnt/c, which breaks Kevin's Windows dev
// server (memory: feedback_wsl_windows_esbuild).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_STATE,
  reduce,
  isTerminal,
  plannerShouldFire,
  workersShouldClaim,
  runFinished,
} from "../../../shared/src/runStateMachine.js";
import type { RunContext, RunState } from "../../../shared/src/runStateMachine.js";

// Default ctx with no work, no audit cycles, single tier. Tests
// override only the fields that matter for the transition under test.
function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    openTodos: 0,
    claimedTodos: 0,
    staleTodos: 0,
    auditInvocations: 0,
    maxAuditInvocations: 3,
    currentTier: 0,
    maxTiers: 0,
    allCriteriaResolved: false,
    ...overrides,
  };
}

describe("runStateMachine — happy path", () => {
  it("idle → spawning on start", () => {
    const next = reduce(INITIAL_STATE, { type: "start", ts: 1 }, ctx());
    assert.equal(next.phase, "spawning");
    assert.equal(next.enteredAt, 1);
  });

  it("spawning → planning on spawned", () => {
    const s: RunState = { phase: "spawning", enteredAt: 1 };
    const next = reduce(s, { type: "spawned", ts: 2, agentCount: 4 }, ctx());
    assert.equal(next.phase, "planning");
    assert.equal(next.enteredAt, 2);
  });

  it("planning stays in planning on contract-built (criteria>0)", () => {
    const s: RunState = { phase: "planning", enteredAt: 2 };
    const next = reduce(s, { type: "contract-built", ts: 3, criteriaCount: 5 }, ctx());
    assert.equal(next.phase, "planning");
  });

  it("planning → executing on todos-posted with count>0", () => {
    const s: RunState = { phase: "planning", enteredAt: 2 };
    const next = reduce(s, { type: "todos-posted", ts: 3, count: 4 }, ctx());
    assert.equal(next.phase, "executing");
  });

  it("planning → auditing on todos-posted with count=0", () => {
    const s: RunState = { phase: "planning", enteredAt: 2 };
    const next = reduce(s, { type: "todos-posted", ts: 3, count: 0 }, ctx());
    assert.equal(next.phase, "auditing");
  });

  it("executing stays while todos remain", () => {
    const s: RunState = { phase: "executing", enteredAt: 3 };
    const next = reduce(
      s,
      { type: "todo-committed", ts: 4, remainingTodos: 2 },
      ctx({ openTodos: 2 }),
    );
    assert.equal(next.phase, "executing");
  });

  it("executing → auditing only when ALL counts are zero", () => {
    const s: RunState = { phase: "executing", enteredAt: 3 };
    const drained = reduce(
      s,
      { type: "todo-committed", ts: 4, remainingTodos: 0 },
      ctx({ openTodos: 0, claimedTodos: 0, staleTodos: 0 }),
    );
    assert.equal(drained.phase, "auditing");
  });

  it("executing stays if claimedTodos still > 0 (in-flight worker)", () => {
    const s: RunState = { phase: "executing", enteredAt: 3 };
    const next = reduce(
      s,
      { type: "todo-committed", ts: 4, remainingTodos: 0 },
      ctx({ openTodos: 0, claimedTodos: 1, staleTodos: 0 }),
    );
    assert.equal(next.phase, "executing");
  });

  it("auditing → executing when auditor produces new todos", () => {
    const s: RunState = { phase: "auditing", enteredAt: 4 };
    const next = reduce(
      s,
      { type: "auditor-returned", ts: 5, allCriteriaResolved: false, newTodosCount: 3 },
      ctx(),
    );
    assert.equal(next.phase, "executing");
  });

  it("auditing → completed when all criteria resolved and no more tiers", () => {
    const s: RunState = { phase: "auditing", enteredAt: 4 };
    const next = reduce(
      s,
      { type: "auditor-returned", ts: 5, allCriteriaResolved: true, newTodosCount: 0 },
      ctx({ currentTier: 0, maxTiers: 0 }),
    );
    assert.equal(next.phase, "completed");
  });

  it("auditing → tier-up when resolved and ratchet allows", () => {
    const s: RunState = { phase: "auditing", enteredAt: 4 };
    const next = reduce(
      s,
      { type: "auditor-returned", ts: 5, allCriteriaResolved: true, newTodosCount: 0 },
      ctx({ currentTier: 0, maxTiers: 2 }),
    );
    assert.equal(next.phase, "tier-up");
  });

  it("tier-up → planning when promoted", () => {
    const s: RunState = { phase: "tier-up", enteredAt: 5 };
    const next = reduce(s, { type: "tier-up-decision", ts: 6, promoted: true }, ctx());
    assert.equal(next.phase, "planning");
  });

  it("tier-up → completed when not promoted", () => {
    const s: RunState = { phase: "tier-up", enteredAt: 5 };
    const next = reduce(s, { type: "tier-up-decision", ts: 6, promoted: false }, ctx());
    assert.equal(next.phase, "completed");
  });
});

describe("runStateMachine — wedge prevention", () => {
  it("auditing terminates when auditor produces no work AND not resolved AND cap not hit", () => {
    // The exact wedge case from V1 (#215, #219, #222). State machine
    // refuses to spin forever when the auditor returns nothing.
    const s: RunState = { phase: "auditing", enteredAt: 4 };
    const next = reduce(
      s,
      { type: "auditor-returned", ts: 5, allCriteriaResolved: false, newTodosCount: 0 },
      ctx({ auditInvocations: 1, maxAuditInvocations: 3 }),
    );
    assert.equal(next.phase, "completed");
    assert.match(next.detail ?? "", /no new work/);
  });

  it("auditing → completed when audit cap reached", () => {
    const s: RunState = { phase: "auditing", enteredAt: 4 };
    const next = reduce(
      s,
      { type: "auditor-returned", ts: 5, allCriteriaResolved: false, newTodosCount: 5 },
      ctx({ auditInvocations: 3, maxAuditInvocations: 3 }),
    );
    assert.equal(next.phase, "completed");
    assert.match(next.detail ?? "", /cap/);
  });

  it("planning → completed when contract has 0 criteria", () => {
    const s: RunState = { phase: "planning", enteredAt: 2 };
    const next = reduce(s, { type: "contract-built", ts: 3, criteriaCount: 0 }, ctx());
    assert.equal(next.phase, "completed");
  });
});

describe("runStateMachine — interrupts", () => {
  it("stop-requested transitions any non-terminal phase to stopped", () => {
    for (const phase of ["spawning", "planning", "executing", "auditing", "tier-up"] as const) {
      const s: RunState = { phase, enteredAt: 1 };
      const next = reduce(s, { type: "stop-requested", ts: 2 }, ctx());
      assert.equal(next.phase, "stopped", `phase=${phase} should stop`);
      assert.equal(next.detail, "user-stop");
    }
  });

  it("stop-requested ignored from terminal phases", () => {
    for (const phase of ["completed", "stopped", "failed"] as const) {
      const s: RunState = { phase, enteredAt: 1, detail: "x" };
      const next = reduce(s, { type: "stop-requested", ts: 2 }, ctx());
      assert.equal(next.phase, phase);
      assert.equal(next.detail, "x");
    }
  });

  it("drain-requested transitions to draining", () => {
    const s: RunState = { phase: "executing", enteredAt: 1 };
    const next = reduce(s, { type: "drain-requested", ts: 2 }, ctx());
    assert.equal(next.phase, "draining");
  });

  it("draining → stopped when last claimed todo finishes", () => {
    const s: RunState = { phase: "draining", enteredAt: 2 };
    const next = reduce(
      s,
      { type: "todo-committed", ts: 3, remainingTodos: 0 },
      ctx({ claimedTodos: 0 }),
    );
    assert.equal(next.phase, "stopped");
    assert.equal(next.detail, "drain-completed");
  });

  it("draining stays while claimed > 0", () => {
    const s: RunState = { phase: "draining", enteredAt: 2 };
    const next = reduce(
      s,
      { type: "todo-committed", ts: 3, remainingTodos: 0 },
      ctx({ claimedTodos: 1 }),
    );
    assert.equal(next.phase, "draining");
  });

  it("fatal-error transitions any phase to failed with message", () => {
    const s: RunState = { phase: "executing", enteredAt: 1 };
    const next = reduce(s, { type: "fatal-error", ts: 2, message: "boom" }, ctx());
    assert.equal(next.phase, "failed");
    assert.equal(next.detail, "boom");
  });
});

describe("runStateMachine — pause/resume (orthogonal)", () => {
  it("pause-on-quota sets pausedReason without changing phase", () => {
    const s: RunState = { phase: "executing", enteredAt: 1 };
    const next = reduce(s, { type: "pause-on-quota", ts: 2, reason: "quota wall" }, ctx());
    assert.equal(next.phase, "executing");
    assert.equal(next.pausedReason, "quota wall");
  });

  it("resume-from-quota clears pausedReason", () => {
    const s: RunState = { phase: "executing", enteredAt: 1, pausedReason: "quota wall" };
    const next = reduce(s, { type: "resume-from-quota", ts: 2 }, ctx());
    assert.equal(next.pausedReason, undefined);
  });

  it("workersShouldClaim is false when paused", () => {
    const s: RunState = { phase: "executing", enteredAt: 1, pausedReason: "quota wall" };
    assert.equal(workersShouldClaim(s), false);
  });

  it("plannerShouldFire is false when paused", () => {
    const s: RunState = { phase: "planning", enteredAt: 1, pausedReason: "quota wall" };
    assert.equal(plannerShouldFire(s), false);
  });
});

describe("runStateMachine — predicates", () => {
  it("isTerminal recognizes terminal phases", () => {
    assert.equal(isTerminal("completed"), true);
    assert.equal(isTerminal("stopped"), true);
    assert.equal(isTerminal("failed"), true);
    assert.equal(isTerminal("executing"), false);
    assert.equal(isTerminal("idle"), false);
  });

  it("workersShouldClaim only true in executing (and not paused)", () => {
    assert.equal(workersShouldClaim({ phase: "executing", enteredAt: 0 }), true);
    assert.equal(workersShouldClaim({ phase: "planning", enteredAt: 0 }), false);
    assert.equal(workersShouldClaim({ phase: "auditing", enteredAt: 0 }), false);
    assert.equal(workersShouldClaim({ phase: "draining", enteredAt: 0 }), false);
  });

  it("plannerShouldFire is true in planning/auditing/tier-up", () => {
    assert.equal(plannerShouldFire({ phase: "planning", enteredAt: 0 }), true);
    assert.equal(plannerShouldFire({ phase: "auditing", enteredAt: 0 }), true);
    assert.equal(plannerShouldFire({ phase: "tier-up", enteredAt: 0 }), true);
    assert.equal(plannerShouldFire({ phase: "executing", enteredAt: 0 }), false);
    assert.equal(plannerShouldFire({ phase: "idle", enteredAt: 0 }), false);
  });

  it("runFinished true for terminal, false otherwise", () => {
    assert.equal(runFinished({ phase: "completed", enteredAt: 0 }), true);
    assert.equal(runFinished({ phase: "stopped", enteredAt: 0 }), true);
    assert.equal(runFinished({ phase: "failed", enteredAt: 0 }), true);
    assert.equal(runFinished({ phase: "executing", enteredAt: 0 }), false);
  });
});

describe("runStateMachine — terminal phases ignore further events", () => {
  it("completed phase ignores all events except fatal-error", () => {
    const s: RunState = { phase: "completed", enteredAt: 1, detail: "done" };
    const events = [
      { type: "start", ts: 2 } as const,
      { type: "spawned", ts: 2, agentCount: 4 } as const,
      { type: "todos-posted", ts: 2, count: 3 } as const,
      { type: "auditor-returned", ts: 2, allCriteriaResolved: false, newTodosCount: 1 } as const,
    ];
    for (const ev of events) {
      const next = reduce(s, ev, ctx());
      assert.equal(next.phase, "completed", `event ${ev.type} should be ignored`);
    }
  });

  it("fatal-error overrides terminal phases", () => {
    // Only fatal errors override terminal — diagnostic catastrophe still
    // propagates so the UI shows the failure rather than a stale "done".
    const s: RunState = { phase: "completed", enteredAt: 1 };
    const next = reduce(s, { type: "fatal-error", ts: 2, message: "post-hoc crash" }, ctx());
    assert.equal(next.phase, "failed");
  });
});

describe("runStateMachine — purity", () => {
  it("reduce never mutates the input state", () => {
    const s: RunState = { phase: "idle", enteredAt: 0 };
    const frozen = Object.freeze({ ...s });
    const next = reduce(frozen, { type: "start", ts: 1 }, ctx());
    assert.notEqual(next, frozen);
    assert.equal(frozen.phase, "idle");
    assert.equal(frozen.enteredAt, 0);
  });
});
