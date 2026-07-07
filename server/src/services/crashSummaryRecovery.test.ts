import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRecoveredCrashSummary, recoverCrashSummaryFromSnapshot } from "./crashSummaryRecovery.js";

describe("crashSummaryRecovery", () => {
  it("builds a crash stopReason from a mid-run snapshot", () => {
    const sum = buildRecoveredCrashSummary(
      {
        runId: "abc-123",
        preset: "council",
        phase: "discussing",
        startedAt: 1_000,
        lastEventAt: 5_000,
        transcript: [
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
    );
    assert.equal(sum.stopReason, "crash");
    assert.match(sum.stopDetail ?? "", /interrupted during "discussing"/);
    assert.equal(sum.agents.length, 1);
    assert.equal(sum.agents[0].agentIndex, 2);
  });

  it("writes summary.json when recovering from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crash-sum-"));
    const runId = "recover-me";
    const snap = {
      runId,
      preset: "council",
      phase: "discussing",
      startedAt: 10_000,
      lastEventAt: 20_000,
      transcript: [] as const,
      runConfig: { localPath: dir, agentCount: 2, preset: "council", model: "m" },
    };
    const written = await recoverCrashSummaryFromSnapshot(snap, dir, runId);
    assert.ok(written);
    assert.ok(existsSync(join(dir, "logs", "summary.json")));
    const raw = JSON.parse(readFileSync(join(dir, "logs", "summary.json"), "utf8"));
    assert.equal(raw.runId, runId);
    assert.equal(raw.stopReason, "crash");
  });
});