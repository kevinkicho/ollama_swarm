import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRecoveredCrashSummary,
  inferCrashPhaseFromTranscript,
  recoverCrashSummaryFromSnapshot,
} from "./crashSummaryRecovery.js";

describe("crashSummaryRecovery", () => {
  it("infers executing phase from council execution transcript markers", () => {
    const phase = inferCrashPhaseFromTranscript([
      { id: "1", role: "system", text: "═══ Council cycle 1 ═══", ts: 1 },
      {
        id: "2",
        role: "system",
        text: "[execution] Starting 4 todo(s)…",
        ts: 2,
        summary: { kind: "council_stage", cycle: 1, stage: "execution", detail: "4 todos" },
      },
    ]);
    assert.equal(phase, "executing");
  });

  it("builds a crash stopReason using inferred phase over stale snapshot phase", () => {
    const sum = buildRecoveredCrashSummary(
      {
        runId: "abc-123",
        preset: "council",
        phase: "discussing",
        startedAt: 1_000,
        lastEventAt: 5_000,
        transcript: [
          {
            id: "2",
            role: "system",
            text: "[execution] Starting 2 todo(s)…",
            ts: 4_000,
            summary: { kind: "council_stage", cycle: 1, stage: "execution", detail: "2 todos" },
          },
          { id: "1", role: "agent", agentIndex: 2, text: "hi", ts: 2_000 },
        ],
        runConfig: {
          localPath: "/tmp/clone",
          agentCount: 4,
          preset: "council",
          model: "test-model",
        },
      },
      "/tmp/clone",
      "abc-123",
      { filesChanged: 3, finalGitStatus: " M README.md" },
    );
    assert.equal(sum.stopReason, "crash");
    assert.match(sum.stopDetail ?? "", /interrupted during "executing"/);
    assert.equal(sum.filesChanged, 3);
    assert.equal(sum.finalGitStatus, " M README.md");
    assert.equal(sum.agents.length, 1);
    assert.equal(sum.agents[0].agentIndex, 2);
  });

  it("writes summary.json when recovering from disk with git status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crash-sum-"));
    const runId = `recover-me-${Date.now()}`;
    const snap = {
      runId,
      preset: "council",
      phase: "discussing",
      startedAt: 10_000,
      lastEventAt: 20_000,
      transcript: [] as const,
      runConfig: { localPath: dir, agentCount: 2, preset: "council", model: "m" },
    };
    const repos = {
      gitStatus: async () => ({ porcelain: " M a.txt", changedFiles: 1 }),
    };
    const written = await recoverCrashSummaryFromSnapshot(snap, dir, runId, repos);
    assert.ok(written);
    assert.ok(existsSync(join(dir, "logs", "summary.json")));
    const raw = JSON.parse(readFileSync(join(dir, "logs", "summary.json"), "utf8"));
    assert.equal(raw.runId, runId);
    assert.equal(raw.stopReason, "crash");
    assert.equal(raw.filesChanged, 1);
  });
});