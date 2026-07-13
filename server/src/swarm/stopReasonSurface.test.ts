/**
 * Settlement / stop-reason surface: summary classification + status earlyStopDetail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSummary, type BuildSummaryInput } from "./blackboard/summary.js";
import { status as buildStatus, type StatusContext } from "./blackboard/statusBuilder.js";

function baseSummary(overrides: Partial<BuildSummaryInput> = {}): BuildSummaryInput {
  return {
    config: {
      repoUrl: "https://example.com/r.git",
      localPath: "/tmp/r",
      preset: "blackboard",
      model: "test",
    },
    startedAt: 1_000,
    endedAt: 5_000,
    stopping: false,
    board: { committed: 1, skipped: 0, total: 3 },
    staleEvents: 0,
    filesChanged: 1,
    finalGitStatus: "",
    agents: [],
    ...overrides,
  };
}

describe("stop-reason surface", () => {
  it("maps no-productive-progress completionDetail to no-progress stopReason", () => {
    const s = buildSummary(
      baseSummary({
        completionDetail:
          "no-productive-progress: 3 cycle(s) without commits, met flips, or new todos",
        contract: {
          missionStatement: "x",
          criteria: [
            { id: "c1", description: "a", expectedFiles: ["a.ts"], status: "unmet" },
          ],
        },
      }),
    );
    assert.equal(s.stopReason, "no-progress");
    assert.match(s.stopDetail ?? "", /no-productive-progress/);
  });

  it("status earlyStopDetail prefers terminationReason then completionDetail", () => {
    const utilCtx = () =>
      ({
        todoQueue: {
          list: () => [],
          counts: () => ({
            pending: 0,
            inProgress: 0,
            pendingCommit: 0,
            completed: 0,
            failed: 0,
            skipped: 0,
            total: 0,
          }),
        },
        findings: { list: () => [] },
      }) as any;

    const withTerm = buildStatus({
      phase: "executing",
      round: 1,
      transcript: [],
      recentLatencySamples: new Map(),
      cloneContract: (c) => c,
      agentStates: () => [],
      getPartialStreams: () => ({}),
      getTerminationReason: () => "cap:wall-clock",
      getCompletionDetail: () => "no-productive-progress: 3",
      utilCtx,
    } as StatusContext);
    assert.equal(withTerm.earlyStopDetail, "cap:wall-clock");

    const withCompletion = buildStatus({
      phase: "executing",
      round: 1,
      transcript: [],
      recentLatencySamples: new Map(),
      cloneContract: (c) => c,
      agentStates: () => [],
      getPartialStreams: () => ({}),
      getTerminationReason: () => undefined,
      getCompletionDetail: () => "no-productive-progress: 3 cycles",
      utilCtx,
    } as StatusContext);
    assert.equal(withCompletion.earlyStopDetail, "no-productive-progress: 3 cycles");
  });
});
