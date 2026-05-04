// R5 (2026-05-04): tests for the auto-resume decision policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutoResume } from "./autoResumeDecision.js";
import type { PersistedRunState } from "../services/RunStatePersister.js";

function snapshot(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    schemaVersion: 2,
    runId: "run-1",
    preset: "blackboard",
    phase: "executing",
    startedAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    transcript: [],
    amendments: [],
    runConfig: {
      preset: "blackboard",
      repoUrl: "https://example.com/x.git",
      localPath: "/tmp/x",
      agentCount: 3,
      rounds: 4,
      model: "glm-5.1:cloud",
    },
    ...overrides,
  };
}

test("decideAutoResume — terminal phase 'completed' → skip", () => {
  const got = decideAutoResume(snapshot({ phase: "completed" }), {
    now: 1_700_000_000_000,
  });
  assert.equal(got.action, "skip");
});

test("decideAutoResume — terminal phase 'stopped' → skip", () => {
  const got = decideAutoResume(snapshot({ phase: "stopped" }), {
    now: 1_700_000_000_000,
  });
  assert.equal(got.action, "skip");
});

test("decideAutoResume — terminal phase 'failed' → skip", () => {
  const got = decideAutoResume(snapshot({ phase: "failed" }), {
    now: 1_700_000_000_000,
  });
  assert.equal(got.action, "skip");
});

test("decideAutoResume — missing runConfig → skip (v1 schema)", () => {
  const snap = snapshot();
  delete snap.runConfig;
  const got = decideAutoResume(snap, { now: 1_700_000_000_000 });
  assert.equal(got.action, "skip");
});

test("decideAutoResume — fresh interrupted run → auto-resume", () => {
  const got = decideAutoResume(snapshot({ phase: "executing" }), {
    now: 1_700_000_000_000 + 60_000, // 1 min ago
  });
  assert.equal(got.action, "auto-resume");
});

test("decideAutoResume — older than 30 min → notify-only", () => {
  const got = decideAutoResume(snapshot({ phase: "executing" }), {
    now: 1_700_000_000_000 + 31 * 60_000,
  });
  assert.equal(got.action, "notify-only");
});

test("decideAutoResume — custom maxAgeMs respected", () => {
  const got = decideAutoResume(snapshot({ phase: "executing" }), {
    now: 1_700_000_000_000 + 10 * 60_000,
    maxAgeMs: 5 * 60_000,
  });
  assert.equal(got.action, "notify-only");
});

test("decideAutoResume — large transcript → notify-only", () => {
  const huge = Array.from({ length: 1500 }, (_, i) => ({ id: `e-${i}` }));
  const got = decideAutoResume(
    snapshot({ phase: "executing", transcript: huge }),
    { now: 1_700_000_000_000 + 60_000 },
  );
  assert.equal(got.action, "notify-only");
});

test("decideAutoResume — custom maxTranscriptLength respected", () => {
  const some = Array.from({ length: 50 }, (_, i) => ({ id: `e-${i}` }));
  const got = decideAutoResume(
    snapshot({ phase: "executing", transcript: some }),
    {
      now: 1_700_000_000_000 + 60_000,
      maxTranscriptLength: 10,
    },
  );
  assert.equal(got.action, "notify-only");
});

test("decideAutoResume — clock skew (now < lastEventAt) → auto-resume", () => {
  const got = decideAutoResume(
    snapshot({ phase: "executing", lastEventAt: 1_700_000_000_000 }),
    { now: 1_699_999_999_000 },
  );
  assert.equal(got.action, "auto-resume");
});

test("decideAutoResume — paused phase is recoverable", () => {
  const got = decideAutoResume(snapshot({ phase: "paused" }), {
    now: 1_700_000_000_000 + 60_000,
  });
  assert.equal(got.action, "auto-resume");
});

test("decideAutoResume — reason text always populated", () => {
  const cases = [
    snapshot({ phase: "completed" }),
    snapshot({ phase: "executing" }),
    snapshot({ phase: "executing", lastEventAt: 1_700_000_000_000 }),
  ];
  for (const s of cases) {
    const got = decideAutoResume(s, { now: 1_700_000_000_000 + 60 * 60_000 });
    assert.ok(got.reason.length > 0, `reason missing for phase=${s.phase}`);
  }
});
