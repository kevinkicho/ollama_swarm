import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectSummaryCandidates,
  inferAgentsFromTranscript,
  loadRunSummaryForRunId,
  readBlackboardStateSync,
  resolveStatusAgents,
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

  it("resolveStatusAgents falls back to blackboard-state agentRoster", async () => {
    const project = await mkdtemp("summary-bb-");
    await fs.writeFile(
      path.join(project, "blackboard-state.json"),
      JSON.stringify({
        agentRoster: [
          { agentId: "agent-1", agentIndex: 1 },
          { agentId: "agent-2", agentIndex: 2 },
        ],
      }),
      "utf8",
    );

    const agents = resolveStatusAgents({
      terminalSum: null,
      clonePath: project,
      runConfig: { agentCount: 2, model: "test-model" },
      transcript: [],
    });
    assert.equal(agents.length, 2);
    assert.equal(agents[0]!.id, "agent-1");
    assert.ok(readBlackboardStateSync(project));

    await fs.rm(project, { recursive: true, force: true });
  });

  it("resolveStatusAgents infers agents from ready lines in transcript", () => {
    const agents = resolveStatusAgents({
      terminalSum: null,
      transcript: [
        { role: "system", text: "Worker agent agent-2 ready (model=glm-5.1)" },
        { role: "system", text: "Planner agent agent-1 ready (model=glm-5.1)" },
      ],
    });
    assert.equal(agents.length, 2);
    assert.equal(agents[0]!.index, 1);
    assert.equal(agents[1]!.index, 2);
    assert.equal(inferAgentsFromTranscript(agents as any).length, 0);
  });
});