import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanForRunDigests } from "./RunsScanner.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("scanForRunDigests", () => {
  it("discovers runs whose summaries live under <project>/logs/<runId>/", async () => {
    const workspace = await mkdtemp("runs-scanner-ws-");
    const project = path.join(workspace, "superconducters_07062026");
    const runLogs = path.join(project, "logs", "470bcf37");
    await fs.mkdir(runLogs, { recursive: true });

    const summary = {
      runId: "470bcf37-ff96-46eb-9138-712200b287ce",
      preset: "blackboard",
      model: "deepseek-v4-flash:cloud",
      localPath: project,
      startedAt: 1_000,
      endedAt: 1_224,
      wallClockMs: 224,
      stopReason: "crash",
      commits: 0,
      totalTodos: 0,
    };
    await fs.writeFile(
      path.join(runLogs, "summary.json"),
      JSON.stringify(summary),
      "utf8",
    );

    const { runs } = await scanForRunDigests(new Set([workspace]));
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, summary.runId);
    assert.equal(path.resolve(runs[0]!.clonePath), path.resolve(project));

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("still reads legacy summaries at the clone root", async () => {
    const parent = await mkdtemp("runs-scanner-root-");
    const clone = path.join(parent, "my-repo");
    await fs.mkdir(clone, { recursive: true });
    const summary = {
      runId: "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      preset: "council",
      model: "glm-5.1:cloud",
      localPath: clone,
      startedAt: 5_000,
      endedAt: 6_000,
      wallClockMs: 1_000,
      stopReason: "completed",
    };
    await fs.writeFile(path.join(clone, "summary.json"), JSON.stringify(summary), "utf8");

    const { runs } = await scanForRunDigests(new Set([parent]));
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, summary.runId);

    await fs.rm(parent, { recursive: true, force: true });
  });
});