import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSummary,
  FINAL_GIT_STATUS_MAX,
  type BuildSummaryInput,
  type PerAgentStat,
} from "./summary.js";

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
