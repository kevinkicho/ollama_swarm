import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildTerminalStatusFromSummary,
  collectClonePathsForSummaryLookup,
  collectSummaryCandidates,
  inferAgentsFromTranscript,
  loadRunSummaryForRunId,
  lookupTerminalSummaryOnDisk,
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
      runConfig: { preset: "blackboard", agentCount: 2, model: "test-model" },
      transcript: [],
    });
    assert.equal(agents.length, 2);
    assert.equal(agents[0]!.id, "agent-1");
    assert.ok(readBlackboardStateSync(project));

    await fs.rm(project, { recursive: true, force: true });
  });

  it("resolveStatusAgents — skips blackboard-state roster for council preset", async () => {
    const project = await mkdtemp("summary-council-");
    await fs.writeFile(
      path.join(project, "blackboard-state.json"),
      JSON.stringify({
        agentRoster: [
          { agentId: "agent-1", agentIndex: 1 },
          { agentId: "agent-2", agentIndex: 2 },
          { agentId: "agent-5", agentIndex: 5 },
          { agentId: "agent-6", agentIndex: 6 },
        ],
      }),
      "utf8",
    );

    const agents = resolveStatusAgents({
      terminalSum: null,
      clonePath: project,
      runConfig: {
        preset: "council",
        agentCount: 4,
        topology: {
          agents: [
            { index: 1, model: "m" },
            { index: 2, model: "m" },
            { index: 3, model: "m" },
            { index: 4, model: "m" },
          ],
        },
      },
      transcript: [],
    });
    assert.equal(agents.length, 4);
    assert.ok(!agents.some((a) => a.id === "agent-5" || a.id === "agent-6"));

    await fs.rm(project, { recursive: true, force: true });
  });

  it("resolveStatusAgents merges partial crash summary with council topology", () => {
    const agents = resolveStatusAgents({
      terminalSum: {
        agents: [{ agentId: "agent-2", agentIndex: 2, model: "deepseek-v4-flash:cloud" }],
      },
      runConfig: {
        preset: "council",
        agentCount: 4,
        topology: {
          agents: [
            { index: 1, model: "deepseek-v4-flash:cloud" },
            { index: 2, model: "deepseek-v4-flash:cloud" },
            { index: 3, model: "deepseek-v4-flash:cloud" },
            { index: 4, model: "deepseek-v4-flash:cloud" },
          ],
        },
      },
      transcript: [],
    });
    assert.equal(agents.length, 4);
    assert.equal(agents[1]!.id, "agent-2");
    assert.equal(agents[1]!.model, "deepseek-v4-flash:cloud");
  });

  it("inferAgentsFromTranscript parses bulk agents-ready line", () => {
    const agents = inferAgentsFromTranscript([
      {
        role: "system",
        text: "4/4 agents ready — models: glm-a:cloud, glm-b:cloud, glm-c:cloud, glm-d:cloud",
      },
    ]);
    assert.equal(agents.length, 4);
    assert.equal(agents[0]!.model, "glm-a:cloud");
    assert.equal(agents[3]!.model, "glm-d:cloud");
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

  it("collectClonePathsForSummaryLookup finds clones with logs/", async () => {
    const workspace = await mkdtemp("summary-parent-");
    const clone = path.join(workspace, "my-project");
    await fs.mkdir(path.join(clone, "logs"), { recursive: true });
    await fs.mkdir(path.join(workspace, "empty-dir"), { recursive: true });

    const found = collectClonePathsForSummaryLookup([workspace]);
    assert.ok(found.some((p) => p.endsWith("my-project")));
    assert.ok(!found.some((p) => p.endsWith("empty-dir")));

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("lookupTerminalSummaryOnDisk + buildTerminalStatusFromSummary", async () => {
    const project = await mkdtemp("summary-lookup-");
    const runId = "a7e91559-e82b-4a74-9a58-5ae4c57664e7";
    const logsDir = path.join(project, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const summary = {
      runId,
      stopReason: "crashed",
      preset: "council",
      startedAt: 1,
      transcript: [{ id: "t1", role: "system", text: "hi", ts: 1 }],
      agents: [{ agentId: "agent-1", agentIndex: 1, model: "test" }],
    };
    await fs.writeFile(
      path.join(logsDir, `summary-${runId}-2026.json`),
      JSON.stringify(summary),
      "utf8",
    );

    const hit = lookupTerminalSummaryOnDisk(runId, [project]);
    assert.ok(hit);
    const status = buildTerminalStatusFromSummary(hit!.summary, runId, hit!.clonePath);
    assert.equal(status.phase, "failed");
    assert.equal(status.transcript?.length, 1);
    assert.equal(status.agents?.[0]?.id, "agent-1");

    await fs.rm(project, { recursive: true, force: true });
  });
});