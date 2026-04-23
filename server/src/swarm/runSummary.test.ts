import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINAL_GIT_STATUS_MAX } from "./blackboard/summary.js";
import {
  buildDiscussionSummary,
  writeRunSummary,
  type DiscussionSummaryInput,
} from "./runSummary.js";

function base(overrides: Partial<DiscussionSummaryInput> = {}): DiscussionSummaryInput {
  return {
    config: {
      repoUrl: "https://github.com/x/y",
      localPath: "/tmp/y",
      preset: "round-robin",
      model: "glm-5.1:cloud",
    },
    agentCount: 3,
    rounds: 5,
    startedAt: 1_000_000,
    endedAt: 1_010_000,
    stopping: false,
    filesChanged: 0,
    finalGitStatus: "",
    agents: [],
    ...overrides,
  };
}

describe("buildDiscussionSummary — common shape", () => {
  it("echoes identity + counts + agents", () => {
    const s = buildDiscussionSummary(base({ agentCount: 4, rounds: 7 }));
    assert.equal(s.repoUrl, "https://github.com/x/y");
    assert.equal(s.localPath, "/tmp/y");
    assert.equal(s.preset, "round-robin");
    assert.equal(s.model, "glm-5.1:cloud");
    assert.equal(s.agentCount, 4);
    assert.equal(s.rounds, 7);
    assert.deepEqual(s.agents, []);
  });

  it("computes wallClockMs = endedAt - startedAt (clamped at 0)", () => {
    assert.equal(
      buildDiscussionSummary(base({ startedAt: 1000, endedAt: 2500 })).wallClockMs,
      1500,
    );
    // Negative delta shouldn't flip to a weird negative number.
    assert.equal(
      buildDiscussionSummary(base({ startedAt: 5000, endedAt: 1000 })).wallClockMs,
      0,
    );
  });

  it("OMITS blackboard-only fields (commits / staleEvents / contract / etc.)", () => {
    const s = buildDiscussionSummary(base());
    assert.equal(s.commits, undefined);
    assert.equal(s.staleEvents, undefined);
    assert.equal(s.skippedTodos, undefined);
    assert.equal(s.totalTodos, undefined);
    assert.equal(s.contract, undefined);
  });
});

describe("buildDiscussionSummary — stop reason classification", () => {
  it("classifies no-crash + no-stopping as 'completed' with no stopDetail", () => {
    const s = buildDiscussionSummary(base({ crashMessage: undefined, stopping: false }));
    assert.equal(s.stopReason, "completed");
    assert.equal(s.stopDetail, undefined);
  });

  it("classifies stopping=true + no-crash as 'user'", () => {
    const s = buildDiscussionSummary(base({ stopping: true }));
    assert.equal(s.stopReason, "user");
  });

  it("classifies crashMessage present as 'crash' (takes precedence over stopping)", () => {
    const s = buildDiscussionSummary(
      base({ crashMessage: "something broke", stopping: true }),
    );
    assert.equal(s.stopReason, "crash");
    assert.equal(s.stopDetail, "something broke");
  });
});

describe("buildDiscussionSummary — git status truncation", () => {
  it("leaves a small gitStatus untouched", () => {
    const s = buildDiscussionSummary(base({ finalGitStatus: "M README.md" }));
    assert.equal(s.finalGitStatus, "M README.md");
    assert.equal(s.finalGitStatusTruncated, false);
  });

  it("truncates a gitStatus that exceeds the shared max", () => {
    const big = "M ".repeat(FINAL_GIT_STATUS_MAX);
    const s = buildDiscussionSummary(base({ finalGitStatus: big }));
    assert.equal(s.finalGitStatus.length, FINAL_GIT_STATUS_MAX);
    assert.equal(s.finalGitStatusTruncated, true);
  });
});

describe("writeRunSummary — on-disk shape", () => {
  it("writes JSON to <clonePath>/summary.json atomically", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "run-summary-"));
    try {
      const s = buildDiscussionSummary(base({ config: { ...base().config, localPath: tmp } }));
      const outPath = await writeRunSummary(tmp, s);
      assert.equal(outPath, path.join(tmp, "summary.json"));
      const roundTripped = JSON.parse(await fs.readFile(outPath, "utf8"));
      assert.equal(roundTripped.preset, "round-robin");
      assert.equal(roundTripped.agentCount, 3);
      assert.equal(roundTripped.rounds, 5);
      assert.equal(roundTripped.stopReason, "completed");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites an existing summary.json when called twice (second wins)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "run-summary-"));
    try {
      const first = buildDiscussionSummary(base({ agentCount: 1 }));
      const second = buildDiscussionSummary(base({ agentCount: 2 }));
      await writeRunSummary(tmp, first);
      await writeRunSummary(tmp, second);
      const roundTripped = JSON.parse(
        await fs.readFile(path.join(tmp, "summary.json"), "utf8"),
      );
      assert.equal(roundTripped.agentCount, 2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
