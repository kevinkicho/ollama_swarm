import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINAL_GIT_STATUS_MAX } from "./blackboard/summary.js";
import {
  buildDiscussionSummary,
  writeRunSummary,
  buildPerRunSummaryFileName,
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
  it("writes JSON to BOTH summary.json and the per-run timestamped file", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "run-summary-"));
    try {
      const s = buildDiscussionSummary(base({ config: { ...base().config, localPath: tmp } }));
      const { perRunPath, latestPath } = await writeRunSummary(tmp, s);
      // Latest pointer at the canonical path.
      assert.equal(latestPath, path.join(tmp, "summary.json"));
      // Per-run sibling whose name encodes startedAt as ISO-with-dashes.
      assert.equal(perRunPath, path.join(tmp, buildPerRunSummaryFileName(s.startedAt)));
      assert.match(path.basename(perRunPath), /^summary-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
      // Both files have identical contents.
      const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
      const perRun = JSON.parse(await fs.readFile(perRunPath, "utf8"));
      assert.deepEqual(latest, perRun);
      assert.equal(latest.preset, "round-robin");
      assert.equal(latest.agentCount, 3);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites only summary.json on a second call — prior per-run file survives", async () => {
    // Unit 49 core promise: build-on-existing-clone runs leave a
    // discoverable trail. summary.json points at the latest; older
    // per-run files remain on disk.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "run-summary-"));
    try {
      const first = buildDiscussionSummary(base({
        agentCount: 1,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
      }));
      const second = buildDiscussionSummary(base({
        agentCount: 2,
        startedAt: 1_700_000_500_000,
        endedAt: 1_700_000_501_000,
      }));
      const { perRunPath: firstPerRun } = await writeRunSummary(tmp, first);
      const { perRunPath: secondPerRun, latestPath } = await writeRunSummary(tmp, second);
      // Per-run files have distinct names, both still on disk.
      assert.notEqual(firstPerRun, secondPerRun);
      const firstRoundTrip = JSON.parse(await fs.readFile(firstPerRun, "utf8"));
      const secondRoundTrip = JSON.parse(await fs.readFile(secondPerRun, "utf8"));
      assert.equal(firstRoundTrip.agentCount, 1, "prior run's per-run file preserved");
      assert.equal(secondRoundTrip.agentCount, 2, "current run's per-run file written");
      // Latest pointer reflects the second run.
      const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
      assert.equal(latest.agentCount, 2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildPerRunSummaryFileName", () => {
  it("produces an ISO-derived name with colons and dots replaced by dashes", () => {
    // Date.UTC(2026, 3, 23, 18, 22, 5, 380) → 2026-04-23T18:22:05.380Z
    const iso = new Date(Date.UTC(2026, 3, 23, 18, 22, 5, 380)).getTime();
    assert.equal(buildPerRunSummaryFileName(iso), "summary-2026-04-23T18-22-05-380Z.json");
  });

  it("sorts lexicographically in chronological order", () => {
    const names = [
      buildPerRunSummaryFileName(Date.UTC(2026, 0, 1, 0, 0, 0, 0)),
      buildPerRunSummaryFileName(Date.UTC(2026, 0, 1, 0, 0, 1, 0)),
      buildPerRunSummaryFileName(Date.UTC(2026, 0, 2, 0, 0, 0, 0)),
      buildPerRunSummaryFileName(Date.UTC(2027, 0, 1, 0, 0, 0, 0)),
    ];
    const sorted = [...names].sort();
    assert.deepEqual(sorted, names, "lex sort must equal chronological");
  });

  it("only contains characters legal on every common filesystem (no : or *)", () => {
    const name = buildPerRunSummaryFileName(Date.now());
    assert.equal(name.match(/[:*?"<>|/\\]/), null);
  });
});
