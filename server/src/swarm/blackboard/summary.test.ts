import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSummary,
  computeLatencyStats,
  detectTerminalQuotaExhaustion,
  extractDeliverables,
  FINAL_GIT_STATUS_MAX,
  isStartupAbort,
  type BuildSummaryInput,
  type PerAgentStat,
} from "./summary.js";
import { classifyError } from "../errorTaxonomy.js";

function baseInput(overrides: Partial<BuildSummaryInput> = {}): BuildSummaryInput {
  return {
    config: {
      repoUrl: "https://example.com/r.git",
      localPath: "/tmp/r",
      preset: "blackboard",
      model: "glm-5.1:cloud",
    },
    startedAt: 1_000,
    endedAt: 5_000,
    stopping: false,
    board: { committed: 5, skipped: 1, total: 7 },
    staleEvents: 2,
    filesChanged: 3,
    finalGitStatus: " M foo.ts\n?? bar.ts\n",
    agents: [],
    ...overrides,
  };
}

function agent(index: number, turns: number): PerAgentStat {
  return {
    agentId: `agent-${index}`,
    agentIndex: index,
    turnsTaken: turns,
    tokensIn: null,
    tokensOut: null,
  };
}

describe("buildSummary — stopReason classification", () => {
  it("reports 'completed' when no stop-related flags are set", () => {
    const s = buildSummary(baseInput());
    assert.equal(s.stopReason, "completed");
    assert.equal(s.stopDetail, undefined);
  });

  it("reports 'user' when stopping is set but no cap reason", () => {
    const s = buildSummary(baseInput({ stopping: true }));
    assert.equal(s.stopReason, "user");
    assert.equal(s.stopDetail, undefined);
  });

  it("reports 'user' when userStopRequested sticky flag is set without lifecycle stopping", () => {
    const s = buildSummary(baseInput({ stopping: false, userStopRequested: true }));
    assert.equal(s.stopReason, "user");
  });

  it("reports 'user' when drain was requested (wasDrained) but lifecycle is still draining", () => {
    const s = buildSummary(
      baseInput({
        stopping: false,
        wasDrained: true,
        v2State: { phase: "draining", enteredAt: 2_000, detail: "drain-requested" },
      }),
    );
    assert.equal(s.stopReason, "user");
  });

  it("reports 'user' when v2 reducer recorded user-stop but stopping flag already cleared", () => {
    const s = buildSummary(
      baseInput({
        stopping: false,
        v2State: { phase: "stopped", enteredAt: 4_000, detail: "user-stop" },
      }),
    );
    assert.equal(s.stopReason, "user");
  });

  it("reports 'crash' when stopped during startup with zero progress and no user-stop signal", () => {
    const input = baseInput({
      startedAt: 1_000,
      endedAt: 1_224,
      stopping: true,
      board: { committed: 0, skipped: 0, total: 0 },
      agents: [],
    });
    assert.equal(isStartupAbort(input), true);
    const s = buildSummary(input);
    assert.equal(s.stopReason, "crash");
    assert.match(s.stopDetail ?? "", /during startup with zero progress/);
  });

  it("reports 'user' when v2 records an explicit user-stop during startup", () => {
    const s = buildSummary(
      baseInput({
        startedAt: 1_000,
        endedAt: 1_224,
        stopping: true,
        board: { committed: 0, skipped: 0, total: 0 },
        agents: [],
        v2State: { phase: "stopped", enteredAt: 1_200, detail: "user-stop" },
      }),
    );
    assert.equal(s.stopReason, "user");
  });

  it("reports 'user' when goal-generation pre-pass produced startup transcript", () => {
    const s = buildSummary(
      baseInput({
        startedAt: 1_000,
        endedAt: 8_000,
        stopping: true,
        board: { committed: 0, skipped: 0, total: 0 },
        agents: [{ agentId: "agent-1", agentIndex: 1, turnsTaken: 0 }],
        transcript: [
          {
            id: "1",
            role: "system",
            text: "Goal-generation pre-pass: analyzing codebase…",
            ts: 1_100,
          },
        ],
      }),
    );
    assert.equal(s.stopReason, "user");
  });

  it("reports 'user' when stopped quickly but agents had turns", () => {
    const s = buildSummary(
      baseInput({
        startedAt: 1_000,
        endedAt: 1_500,
        stopping: true,
        board: { committed: 0, skipped: 0, total: 0 },
        agents: [agent(1, 2)],
      }),
    );
    assert.equal(s.stopReason, "user");
  });

  it("reports 'cap:wall-clock' and preserves detail when wall-clock cap tripped", () => {
    const s = buildSummary(
      baseInput({ stopping: true, terminationReason: "wall-clock cap reached (20 min)" }),
    );
    assert.equal(s.stopReason, "cap:wall-clock");
    assert.equal(s.stopDetail, "wall-clock cap reached (20 min)");
  });

  it("reports 'cap:commits' when commits cap tripped", () => {
    const s = buildSummary(
      baseInput({ stopping: true, terminationReason: "commits cap reached (20)" }),
    );
    assert.equal(s.stopReason, "cap:commits");
  });

  it("reports 'cap:todos' when todos cap tripped", () => {
    const s = buildSummary(
      baseInput({ stopping: true, terminationReason: "todos cap reached (30)" }),
    );
    assert.equal(s.stopReason, "cap:todos");
  });

  it("reports 'crash' and preserves crash message even when stopping is also set", () => {
    const s = buildSummary(
      baseInput({ crashMessage: "kaboom", stopping: true, terminationReason: "commits cap reached (20)" }),
    );
    // Crash takes precedence over cap + user-stop.
    assert.equal(s.stopReason, "crash");
    assert.equal(s.stopDetail, "kaboom");
  });

  it("falls back to cap:wall-clock for an unknown terminationReason shape", () => {
    const s = buildSummary(
      baseInput({ stopping: true, terminationReason: "some new cap we added later" }),
    );
    assert.equal(s.stopReason, "cap:wall-clock");
    assert.equal(s.stopDetail, "some new cap we added later");
  });

  // Issue #2 (2026-04-27): zero-progress detector. A run that didn't
  // crash, didn't get user-stopped, didn't trip a cap, and produced
  // 0 commits + 0 todos with all criteria still unmet should NOT be
  // classified as a successful "completed" — that hides planner failure
  // behind a green pill in the UI.
  it("reports 'no-progress' when 0 todos, 0 commits, and all criteria unmet", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 0, skipped: 0, total: 0 },
        contract: {
          missionStatement: "Add CONTRIBUTING.md",
          criteria: [
            { id: "c1", description: "x", expectedFiles: ["CONTRIBUTING.md"], status: "unmet", addedAt: 0 },
            { id: "c2", description: "y", expectedFiles: ["package.json"], status: "unmet", addedAt: 0 },
          ],
        },
      }),
    );
    assert.equal(s.stopReason, "no-progress");
    assert.match(s.stopDetail ?? "", /no actionable todos|all criteria still unmet/i);
  });

  it("stays 'completed' when 0 commits but at least one criterion was met", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 0, skipped: 0, total: 0 },
        contract: {
          missionStatement: "Some mission",
          criteria: [
            { id: "c1", description: "x", expectedFiles: ["a.ts"], status: "met", addedAt: 0 },
            { id: "c2", description: "y", expectedFiles: ["b.ts"], status: "unmet", addedAt: 0 },
          ],
        },
      }),
    );
    assert.equal(s.stopReason, "completed");
  });

  it("reports 'no-progress' when some criteria met/wont-do but unmet remain and auditor+planner stuck", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 6, skipped: 0, total: 26 },
        completionDetail: "auditor + planner produced no new work; unresolved criteria remain",
        contract: {
          missionStatement: "Clean up root artifacts",
          criteria: [
            { id: "c1", description: "move files", expectedFiles: [".gitignore"], status: "wont-do", addedAt: 0 },
            { id: "c2", description: "update .gitignore", expectedFiles: [".gitignore"], status: "unmet", addedAt: 0 },
            { id: "c3", description: "done criterion", expectedFiles: ["app/api/swarm/run/route.ts"], status: "met", addedAt: 0 },
          ],
        },
      }),
    );
    assert.equal(s.stopReason, "no-progress");
    assert.match(s.stopDetail ?? "", /no new work/);
  });

  it("reports 'no-progress' for 8e5ab2-shaped stall (1 commit, 26 skipped, all criteria unmet)", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 1, skipped: 26, total: 39 },
        staleEvents: 45,
        completionDetail: "auditor + planner produced no new work; unresolved criteria remain",
        contract: {
          missionStatement: "Add government data panels",
          criteria: Array.from({ length: 12 }, (_, i) => ({
            id: `c${i + 1}`,
            description: `criterion ${i + 1}`,
            expectedFiles: [`src/p${i + 1}.jsx`],
            status: "unmet" as const,
            addedAt: 0,
          })),
        },
      }),
    );
    assert.equal(s.stopReason, "no-progress");
  });

  it("reports 'no-progress' for no-productive-progress completionDetail", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 2, skipped: 4, total: 10 },
        completionDetail:
          "no-productive-progress: 3 cycle(s) without commits, met flips, or new todos",
        contract: {
          missionStatement: "ship",
          criteria: [
            { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet" },
            { id: "c2", description: "b", expectedFiles: ["b.ts"], status: "met" },
          ],
        },
        agents: [agent(1, 5)],
      }),
    );
    assert.equal(s.stopReason, "no-progress");
    assert.match(s.stopDetail ?? "", /no-productive-progress/);
  });

  it("reports 'no-progress' when all criteria unmet and auditor+planner stuck despite commits", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 3, skipped: 0, total: 3 },
        completionDetail: "auditor + planner produced no new work; unresolved criteria remain",
        contract: {
          missionStatement: "Some mission",
          criteria: [
            { id: "c1", description: "x", expectedFiles: ["a.ts"], status: "unmet", addedAt: 0 },
            { id: "c2", description: "y", expectedFiles: ["b.ts"], status: "unmet", addedAt: 0 },
          ],
        },
      }),
    );
    assert.equal(s.stopReason, "no-progress");
    assert.match(s.stopDetail ?? "", /no new work/);
  });

  it("stays 'completed' when no contract is present and no completionDetail (discussion-style)", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 0, skipped: 0, total: 0 },
        contract: undefined,
      }),
    );
    assert.equal(s.stopReason, "completed");
  });

  it("reports 'cap:quota' when terminal window is all quota errors", () => {
    const quotaErrors = Array.from({ length: 8 }, (_, i) =>
      classifyError({ message: `rate limit ${i}`, statusCode: 429 }),
    );
    const s = buildSummary(
      baseInput({
        completionDetail: "auditor + planner produced no new work; unresolved criteria remain",
        board: { committed: 0, skipped: 0, stale: 0, total: 5 },
        agents: [agent(1, 12)],
        errors: quotaErrors,
      }),
    );
    assert.equal(s.stopReason, "cap:quota");
    assert.match(s.stopDetail ?? "", /quota/);
  });

  it("detectTerminalQuotaExhaustion — transcript streak of 429 retries", () => {
    const transcript = Array.from({ length: 8 }, (_, i) => ({
      id: `t-${i}`,
      role: "system" as const,
      text: "[agent-1] transport error (429) — retry 3/5 in 30s",
      ts: i,
    }));
    const detail = detectTerminalQuotaExhaustion({
      errors: [],
      agents: [{ ...agent(1, 8), successfulAttempts: 0 }],
      transcript,
    });
    assert.ok(detail);
    assert.match(detail, /consecutive quota/);
  });

  it("reports 'no-progress' when no contract and planner left zero board activity", () => {
    const s = buildSummary(
      baseInput({
        board: { committed: 0, skipped: 0, total: 0 },
        contract: undefined,
        completionDetail: "planner produced no actionable todos; no commits",
      }),
    );
    assert.equal(s.stopReason, "no-progress");
    assert.match(s.stopDetail ?? "", /no actionable todos/i);
  });
});

describe("buildSummary — metrics passthrough", () => {
  it("computes wallClockMs as endedAt - startedAt", () => {
    const s = buildSummary(baseInput({ startedAt: 10_000, endedAt: 25_500 }));
    assert.equal(s.wallClockMs, 15_500);
  });

  it("clamps wallClockMs at 0 when endedAt < startedAt (clock skew)", () => {
    const s = buildSummary(baseInput({ startedAt: 5_000, endedAt: 4_000 }));
    assert.equal(s.wallClockMs, 0);
  });

  it("passes board counts through to commits/skippedTodos/totalTodos", () => {
    const s = buildSummary(baseInput({ board: { committed: 8, skipped: 2, total: 12 } }));
    assert.equal(s.commits, 8);
    assert.equal(s.skippedTodos, 2);
    assert.equal(s.totalTodos, 12);
  });

  it("passes staleEvents and filesChanged through verbatim", () => {
    const s = buildSummary(baseInput({ staleEvents: 7, filesChanged: 11 }));
    assert.equal(s.staleEvents, 7);
    assert.equal(s.filesChanged, 11);
  });

  it("copies config into flat fields", () => {
    const s = buildSummary(
      baseInput({
        config: {
          repoUrl: "https://github.com/x/y",
          localPath: "/a/b",
          preset: "blackboard",
          model: "glm-5.1:cloud",
        },
      }),
    );
    assert.equal(s.repoUrl, "https://github.com/x/y");
    assert.equal(s.localPath, "/a/b");
    assert.equal(s.preset, "blackboard");
    assert.equal(s.model, "glm-5.1:cloud");
  });
});

describe("buildSummary — finalGitStatus", () => {
  it("leaves short status untouched and sets truncated=false", () => {
    const s = buildSummary(baseInput({ finalGitStatus: " M a.ts\n" }));
    assert.equal(s.finalGitStatus, " M a.ts\n");
    assert.equal(s.finalGitStatusTruncated, false);
  });

  it("truncates long status at FINAL_GIT_STATUS_MAX and flags it", () => {
    const huge = "X".repeat(FINAL_GIT_STATUS_MAX + 500);
    const s = buildSummary(baseInput({ finalGitStatus: huge }));
    assert.equal(s.finalGitStatus.length, FINAL_GIT_STATUS_MAX);
    assert.equal(s.finalGitStatusTruncated, true);
  });

  it("keeps status exactly at cap length untruncated", () => {
    const exact = "Y".repeat(FINAL_GIT_STATUS_MAX);
    const s = buildSummary(baseInput({ finalGitStatus: exact }));
    assert.equal(s.finalGitStatus.length, FINAL_GIT_STATUS_MAX);
    assert.equal(s.finalGitStatusTruncated, false);
  });
});

describe("buildSummary — per-agent stats", () => {
  it("passes agents array through unchanged (copied defensively)", () => {
    const agents = [agent(1, 4), agent(2, 6), agent(3, 2)];
    const s = buildSummary(baseInput({ agents }));
    assert.equal(s.agents.length, 3);
    assert.deepEqual(s.agents, agents);
    // Defensive copy: mutating the output doesn't touch the input.
    s.agents.push(agent(99, 0));
    assert.equal(agents.length, 3);
  });

  it("preserves null token counts (SDK doesn't expose usage)", () => {
    const s = buildSummary(baseInput({ agents: [agent(1, 3)] }));
    assert.equal(s.agents[0].tokensIn, null);
    assert.equal(s.agents[0].tokensOut, null);
  });
});

describe("buildSummary — JSON roundtrip", () => {
  it("produces a JSON-serializable object", () => {
    const s = buildSummary(
      baseInput({
        stopping: true,
        terminationReason: "commits cap reached (20)",
        agents: [agent(1, 5), agent(2, 3)],
      }),
    );
    const round = JSON.parse(JSON.stringify(s));
    assert.equal(round.stopReason, "cap:commits");
    assert.equal(round.agents[0].turnsTaken, 5);
    assert.equal(round.wallClockMs, 4_000);
  });
});

describe("buildSummary — Phase 11c contract + completionDetail", () => {
  it("includes completionDetail on a clean completed run", () => {
    const s = buildSummary(
      baseInput({ completionDetail: "all contract criteria satisfied" }),
    );
    assert.equal(s.stopReason, "completed");
    assert.equal(s.stopDetail, "all contract criteria satisfied");
  });

  it("ignores completionDetail when a cap tripped", () => {
    const s = buildSummary(
      baseInput({
        stopping: true,
        terminationReason: "wall-clock cap reached (20 min)",
        completionDetail: "all contract criteria satisfied",
      }),
    );
    assert.equal(s.stopReason, "cap:wall-clock");
    assert.equal(s.stopDetail, "wall-clock cap reached (20 min)");
  });

  it("passes contract through with a defensive copy", () => {
    const contract = {
      missionStatement: "Ship it.",
      criteria: [
        {
          id: "c1",
          description: "README has quick start",
          expectedFiles: ["README.md"],
          status: "met" as const,
          rationale: "Added in commit abc.",
          addedAt: 100,
        },
      ],
    };
    const s = buildSummary(baseInput({ contract }));
    assert.equal(s.contract?.missionStatement, "Ship it.");
    assert.equal(s.contract?.criteria[0]?.status, "met");
    assert.equal(s.contract?.criteria[0]?.rationale, "Added in commit abc.");
    // Defensive copy: mutating the output does not touch the input.
    s.contract!.criteria[0]!.expectedFiles.push("OTHER.md");
    assert.deepEqual(contract.criteria[0].expectedFiles, ["README.md"]);
  });

  it("leaves contract undefined when not supplied", () => {
    const s = buildSummary(baseInput());
    assert.equal(s.contract, undefined);
  });
});

// Unit 21: per-agent latency telemetry helper. Pure function — easy to
// lock down with a few directed inputs.
describe("computeLatencyStats", () => {
  it("returns null fields for empty input (so summary doesn't fake stats)", () => {
    const s = computeLatencyStats([]);
    assert.equal(s.mean, null);
    assert.equal(s.p50, null);
    assert.equal(s.p95, null);
  });

  it("computes mean / p50 / p95 for a single sample", () => {
    const s = computeLatencyStats([1500]);
    assert.equal(s.mean, 1500);
    assert.equal(s.p50, 1500);
    assert.equal(s.p95, 1500);
  });

  it("returns sorted percentiles regardless of input order", () => {
    const s = computeLatencyStats([300, 100, 200, 500, 400]);
    assert.equal(s.mean, 300, "mean of 100,200,300,400,500 = 300");
    assert.equal(s.p50, 300, "median is 300");
    assert.equal(s.p95, 500, "p95 of 5 samples = max sample");
  });

  it("handles a realistic latency distribution (1-2s normal, one slow tail)", () => {
    const samples = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 12_000];
    const s = computeLatencyStats(samples);
    assert.equal(s.p50, 1400, "median sits in the bulk");
    assert.equal(s.p95, 12_000, "p95 catches the slow tail");
    assert.equal(s.mean, 2460, "mean is dragged up by the outlier");
  });

  it("does not mutate the input array", () => {
    const samples = [3, 1, 2];
    computeLatencyStats(samples);
    assert.deepEqual(samples, [3, 1, 2]);
  });
});

describe("buildSummary — per-agent stats (Unit 21 fields passthrough)", () => {
  it("passes through totalAttempts / totalRetries / latency fields", () => {
    const agents: PerAgentStat[] = [
      {
        agentId: "agent-1",
        agentIndex: 1,
        turnsTaken: 4,
        tokensIn: null,
        tokensOut: null,
        totalAttempts: 6,
        totalRetries: 2,
        successfulAttempts: 4,
        meanLatencyMs: 78_000,
        p50LatencyMs: 45_000,
        p95LatencyMs: 180_000,
      },
    ];
    const s = buildSummary(baseInput({ agents }));
    assert.equal(s.agents.length, 1);
    const a = s.agents[0];
    assert.equal(a.totalAttempts, 6);
    assert.equal(a.totalRetries, 2);
    assert.equal(a.successfulAttempts, 4);
    assert.equal(a.meanLatencyMs, 78_000);
    assert.equal(a.p50LatencyMs, 45_000);
    assert.equal(a.p95LatencyMs, 180_000);
  });

  it("works when Unit 21 fields are absent (older callers / pre-migration)", () => {
    const agents: PerAgentStat[] = [
      { agentId: "agent-1", agentIndex: 1, turnsTaken: 4, tokensIn: null, tokensOut: null },
    ];
    const s = buildSummary(baseInput({ agents }));
    assert.equal(s.agents[0].totalAttempts, undefined);
    assert.equal(s.agents[0].p50LatencyMs, undefined);
  });
});

describe("extractDeliverables", () => {
  it("returns undefined for empty porcelain", () => {
    assert.equal(extractDeliverables(""), undefined);
    assert.equal(extractDeliverables("  "), undefined);
  });

  it("classifies added and untracked files as created", () => {
    const porcelain = "A  src/new.ts\n?? lib/added.js\nM  src/existing.ts";
    const d = extractDeliverables(porcelain)!;
    assert.equal(d.length, 3);
    assert.deepEqual(d[0], { path: "src/new.ts", status: "created" });
    assert.deepEqual(d[1], { path: "lib/added.js", status: "created" });
    assert.deepEqual(d[2], { path: "src/existing.ts", status: "modified" });
  });

  it("caps at 50 entries", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `M  file${i}.ts`).join("\n");
    const d = extractDeliverables(lines)!;
    assert.equal(d.length, 50);
  });

  it("returns undefined when all lines are empty", () => {
    assert.equal(extractDeliverables("\n\n"), undefined);
  });
});

// Phase 10: phase data (currentPhase/phases) emitters removed; buildSummary no longer special-cases.
// Pass-through of legacy keys on input is tolerated for old data.
describe("buildSummary — Phase 10 (no phase state population)", () => {
  it("builds summary without requiring phase data", () => {
    const s = buildSummary(baseInput({ preset: "blackboard" as any }));
    assert.ok(s);
  });

  it("tolerates legacy phase keys on transcript (pass-through)", () => {
    const transcript = [
      { id: "e1", role: "system" as const, text: "note", ts: 1, phaseIndex: 0, phasePreset: "council" },
    ];
    const s = buildSummary(baseInput({ transcript }));
    assert.equal(s.transcript[0].phaseIndex, 0);
  });
});
