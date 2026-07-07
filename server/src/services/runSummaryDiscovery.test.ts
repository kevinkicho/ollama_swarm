import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectSummaryCandidates,
  loadRunSummaryForRunId,
  shapeAgentsFromSummary,
} from "./runSummaryDiscovery.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("runSummaryDiscovery", () => {
  it("collects summaries from logs/<runId>/ subdirs", async () => {
    const project = await mkdtemp("summary-disc-");
    const runLogs = path.join(project, "logs", "ca367846");
    await fs.mkdir(runLogs, { recursive: true });
    await fs.writeFile(path.join(runLogs, "summary.json"), "{}", "utf8");

    const cands = collectSummaryCandidates(project);
    assert.ok(cands.some((c) => c.endsWith(path.join("logs", "ca367846", "summary.json"))));

    await fs.rm(project, { recursive: true, force: true });
  });

  it("loadRunSummaryForRunId returns matching summary with agents", async () => {
    const project = await mkdtemp("summary-load-");
    const runId = "ca367846-19c8-4710-9a4a-e90e522315e0";
    const runLogs = path.join(project, "logs", "ca367846");
    await fs.mkdir(runLogs, { recursive: true });
    const summary = {
      runId,
      stopReason: "user",
      agents: [{ agentId: "agent-1", agentIndex: 1, turnsTaken: 3 }],
    };
    await fs.writeFile(path.join(runLogs, "summary.json"), JSON.stringify(summary), "utf8");

    const loaded = loadRunSummaryForRunId(project, runId);
    assert.equal(loaded?.runId, runId);
    assert.equal(loaded?.stopReason, "user");
    const shaped = shapeAgentsFromSummary(loaded!);
    assert.equal(shaped.length, 1);
    assert.equal(shaped[0]!.id, "agent-1");

    await fs.rm(project, { recursive: true, force: true });
  });
});