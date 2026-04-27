// V2 Step 4 follow-up: tests for the discriminated-union summary
// formatter. Imports from shared/ (the canonical location post-move).
//
// Coverage rationale: formatServerSummary has 17+ envelope kinds in a
// switch ladder. A bug in any one branch silently gives users the
// wrong header text — easy to miss in manual smoke. Cover every branch
// + the pluralization edge cases (1 round vs 2 rounds, 1 hunk vs N
// hunks, etc).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatServerSummary } from "../../../../shared/src/formatServerSummary.js";
import type { TranscriptEntrySummary } from "../../../../shared/src/transcriptEntrySummary.js";

describe("formatServerSummary — worker shapes", () => {
  it("worker_skip → Declined: <reason>", () => {
    const out = formatServerSummary({
      kind: "worker_skip",
      reason: "expectedFile doesn't exist",
    });
    assert.equal(out, "Declined: expectedFile doesn't exist");
  });

  it("worker_hunks single hunk in one file", () => {
    const out = formatServerSummary({
      kind: "worker_hunks",
      hunkCount: 1,
      ops: { replace: 1, create: 0, append: 0 },
      multipleFiles: false,
      firstFile: "src/a.ts",
      totalChars: 100,
    });
    assert.equal(out, "Wrote 1 hunk (1 replace) in src/a.ts (100 chars)");
  });

  it("worker_hunks multi-op single file", () => {
    const out = formatServerSummary({
      kind: "worker_hunks",
      hunkCount: 3,
      ops: { replace: 1, create: 1, append: 1 },
      multipleFiles: false,
      firstFile: "src/b.ts",
      totalChars: 1234,
    });
    assert.equal(
      out,
      "Wrote 3 hunks (1 replace, 1 create, 1 append) in src/b.ts (1,234 chars)",
    );
  });

  it("worker_hunks across multiple files", () => {
    const out = formatServerSummary({
      kind: "worker_hunks",
      hunkCount: 5,
      ops: { replace: 5, create: 0, append: 0 },
      multipleFiles: true,
      firstFile: "src/a.ts",
      totalChars: 0,
    });
    assert.equal(out, "Wrote 5 hunks (5 replace) across multiple files");
  });

  it("worker_hunks no firstFile (defensive '(no file)')", () => {
    const out = formatServerSummary({
      kind: "worker_hunks",
      hunkCount: 1,
      ops: { create: 1, replace: 0, append: 0 },
      multipleFiles: false,
      totalChars: 50,
    });
    assert.equal(out, "Wrote 1 hunk (1 create) (no file) (50 chars)");
  });
});

describe("formatServerSummary — orchestrator-worker", () => {
  it("ow_assignments single subtask", () => {
    const out = formatServerSummary({
      kind: "ow_assignments",
      subtaskCount: 1,
      assignments: [{ agentIndex: 2, subtask: "audit configs" }],
    });
    assert.equal(out, "Orchestrator assigned 1 subtask:\n  → agent-2: audit configs");
  });

  it("ow_assignments multi subtask", () => {
    const out = formatServerSummary({
      kind: "ow_assignments",
      subtaskCount: 3,
      assignments: [
        { agentIndex: 2, subtask: "first thing" },
        { agentIndex: 3, subtask: "second thing" },
        { agentIndex: 4, subtask: "third thing" },
      ],
    });
    assert.equal(
      out,
      "Orchestrator assigned 3 subtasks:\n  → agent-2: first thing\n  → agent-3: second thing\n  → agent-4: third thing",
    );
  });
});

describe("formatServerSummary — council + debate", () => {
  it("council_draft", () => {
    const out = formatServerSummary({
      kind: "council_draft",
      round: 2,
      phase: "draft",
    });
    assert.equal(out, "Council · round 2 · draft");
  });

  it("debate_turn — JUDGE/PRO/CON role uppercased", () => {
    const out = formatServerSummary({
      kind: "debate_turn",
      round: 1,
      role: "judge",
    });
    assert.equal(out, "Debate · round 1 · JUDGE");
  });

  it("council_synthesis singular round", () => {
    const out = formatServerSummary({ kind: "council_synthesis", rounds: 1 });
    assert.equal(out, "Council synthesis (1 round)");
  });

  it("council_synthesis plural rounds", () => {
    const out = formatServerSummary({ kind: "council_synthesis", rounds: 4 });
    assert.equal(out, "Council synthesis (4 rounds)");
  });

  it("debate_verdict — winner uppercased", () => {
    const out = formatServerSummary({
      kind: "debate_verdict",
      winner: "pro",
      confidence: "high",
      round: 3,
      proStrongest: "x",
      proWeakest: "y",
      conStrongest: "a",
      conWeakest: "b",
      decisive: "decisive",
      nextAction: "go",
    });
    assert.equal(out, "Debate verdict — PRO (high)");
  });
});

describe("formatServerSummary — synthesis kinds", () => {
  it("stigmergy_report", () => {
    const out = formatServerSummary({
      kind: "stigmergy_report",
      filesRanked: 12,
    });
    assert.equal(out, "Stigmergy report-out (12 files ranked)");
  });

  it("stretch_goals", () => {
    const out = formatServerSummary({
      kind: "stretch_goals",
      goals: ["a", "b", "c"],
      tier: 2,
      committed: 5,
    });
    assert.equal(out, "Stretch goals (3 ranked, tier 2)");
  });

  it("mapreduce_synthesis", () => {
    const out = formatServerSummary({ kind: "mapreduce_synthesis", cycle: 1 });
    assert.equal(out, "Map-reduce synthesis (cycle 1)");
  });

  it("role_diff_synthesis singular", () => {
    const out = formatServerSummary({
      kind: "role_diff_synthesis",
      rounds: 1,
      roles: 1,
    });
    assert.equal(out, "Role-diff synthesis (1 round, 1 roles)");
  });

  it("role_diff_synthesis plural", () => {
    const out = formatServerSummary({
      kind: "role_diff_synthesis",
      rounds: 3,
      roles: 4,
    });
    assert.equal(out, "Role-diff synthesis (3 rounds, 4 roles)");
  });

  it("next_action_phase", () => {
    const out = formatServerSummary({
      kind: "next_action_phase",
      role: "implementer",
    });
    assert.equal(out, "Build phase — implementer");
  });
});

describe("formatServerSummary — system entries", () => {
  it("run_finished", () => {
    const out = formatServerSummary({
      kind: "run_finished",
      preset: "blackboard",
      model: "glm-5.1:cloud",
      repoUrl: "https://example/repo",
      clonePath: "/tmp/repo",
      startedAt: 0,
      endedAt: 60000,
      stopReason: "user-stop",
      stopDetail: "user pressed stop",
      commits: 3,
      filesChanged: 5,
      wallClockMs: 60000,
      linesAdded: 100,
      linesRemoved: 30,
      agents: [],
    });
    assert.equal(out, "Run finished — user-stop");
  });

  it("seed_announce", () => {
    const out = formatServerSummary({
      kind: "seed_announce",
      repoUrl: "https://example/repo",
      clonePath: "/tmp/repo",
      topLevel: ["src", "tests", "docs"],
    });
    assert.equal(out, "Project seed — 3 top-level entries");
  });

  it("verifier_verdict", () => {
    const out = formatServerSummary({
      kind: "verifier_verdict",
      verdict: "verified",
      proposingAgentId: "agent-2",
      todoDescription: "test",
      evidenceCitation: "src/a.ts:5",
      rationale: "passes",
    });
    assert.equal(out, "Verifier verified on agent-2");
  });
});

describe("formatServerSummary — quota wall", () => {
  it("quota_paused with statusCode", () => {
    const out = formatServerSummary({
      kind: "quota_paused",
      statusCode: 429,
      reason: "rate limited",
    });
    assert.equal(
      out,
      "Paused — Ollama wall (429); probing every 5min until clear",
    );
  });

  it("quota_paused without statusCode falls back to 'quota'", () => {
    const out = formatServerSummary({
      kind: "quota_paused",
      reason: "no detail",
    });
    assert.equal(
      out,
      "Paused — Ollama wall (quota); probing every 5min until clear",
    );
  });

  it("quota_resumed converts ms → minutes", () => {
    const out = formatServerSummary({
      kind: "quota_resumed",
      pausedMs: 5 * 60_000,
      totalPausedMs: 5 * 60_000,
    });
    assert.equal(out, "Resumed — wall cleared after ~5 min");
  });

  it("quota_resumed rounds to nearest minute", () => {
    const out = formatServerSummary({
      kind: "quota_resumed",
      pausedMs: 4.6 * 60_000, // 276s → ceil to 5
      totalPausedMs: 4.6 * 60_000,
    });
    assert.equal(out, "Resumed — wall cleared after ~5 min");
  });
});

describe("formatServerSummary — exhaustiveness", () => {
  it("never returns undefined or empty for any envelope kind", () => {
    // Defensive check: as new envelope kinds are added to the union,
    // formatServerSummary must handle them. If a kind falls through
    // to the worker_hunks branch it'll throw on missing fields. This
    // test isn't a substitute for adding per-kind tests above, but
    // it catches "added kind, forgot to handle" regressions.
    const samples: TranscriptEntrySummary[] = [
      { kind: "worker_skip", reason: "x" },
      {
        kind: "worker_hunks",
        hunkCount: 1,
        ops: { replace: 1, create: 0, append: 0 },
        multipleFiles: false,
        firstFile: "x.ts",
        totalChars: 1,
      },
      {
        kind: "ow_assignments",
        subtaskCount: 1,
        assignments: [{ agentIndex: 2, subtask: "x" }],
      },
      { kind: "council_draft", round: 1, phase: "draft" },
      { kind: "debate_turn", round: 1, role: "pro" },
      {
        kind: "run_finished",
        preset: "blackboard",
        model: "x",
        repoUrl: "u",
        clonePath: "p",
        startedAt: 0,
        endedAt: 0,
        wallClockMs: 0,
        stopReason: "completed",
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        agents: [],
      },
      { kind: "seed_announce", repoUrl: "u", clonePath: "p", topLevel: [] },
      { kind: "council_synthesis", rounds: 1 },
      { kind: "stigmergy_report", filesRanked: 0 },
      { kind: "stretch_goals", goals: [], tier: 1, committed: 0 },
      {
        kind: "verifier_verdict",
        verdict: "verified",
        proposingAgentId: "x",
        todoDescription: "y",
        evidenceCitation: "z",
      },
      {
        kind: "debate_verdict",
        winner: "tie",
        confidence: "low",
        round: 1,
        proStrongest: "",
        conStrongest: "",
        proWeakest: "",
        conWeakest: "",
        decisive: "",
        nextAction: "",
      },
      { kind: "mapreduce_synthesis", cycle: 1 },
      { kind: "role_diff_synthesis", rounds: 1, roles: 1 },
      { kind: "next_action_phase", role: "announcement" },
      { kind: "quota_paused", reason: "x" },
      { kind: "quota_resumed", pausedMs: 0, totalPausedMs: 0 },
    ];
    for (const s of samples) {
      const out = formatServerSummary(s);
      assert.ok(typeof out === "string" && out.length > 0, `kind=${s.kind} returned empty`);
    }
  });
});
