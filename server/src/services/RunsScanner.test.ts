import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanForRunDigests, scanAppRunRegistry, clearRunsListCache } from "./RunsScanner.js";

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

    clearRunsListCache();
    const { runs } = await scanForRunDigests(new Set([workspace]));
    const mine = runs.filter((r) => r.runId === summary.runId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.runId, summary.runId);
    assert.equal(path.resolve(mine[0]!.clonePath), path.resolve(project));

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

    clearRunsListCache();
    const { runs } = await scanForRunDigests(new Set([parent]));
    // May also pick up app-registry runs from process.cwd(); filter to our fixture.
    const mine = runs.filter((r) => r.runId === summary.runId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.runId, summary.runId);

    await fs.rm(parent, { recursive: true, force: true });
  });

  it("scanAppRunRegistry discovers summaries under cwd/logs/<runId>/", async () => {
    const prev = process.cwd();
    const appRoot = await mkdtemp("runs-scanner-app-");
    try {
      process.chdir(appRoot);
      const runId = "df1eab0b-f7e3-4724-9ff8-842bef332cc2";
      const runDir = path.join(appRoot, "logs", runId);
      await fs.mkdir(runDir, { recursive: true });
      const summary = {
        runId,
        preset: "council",
        model: "x",
        localPath: "C:\\Users\\kevin\\workspace\\kyahoofinance032926",
        startedAt: Date.now() - 10_000,
        endedAt: Date.now(),
        wallClockMs: 10_000,
        stopReason: "completed",
      };
      await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary), "utf8");
      // recover-me should be skipped
      const junk = path.join(appRoot, "logs", "recover-me-123");
      await fs.mkdir(junk, { recursive: true });
      await fs.writeFile(
        path.join(junk, "summary.json"),
        JSON.stringify({ ...summary, runId: "recover-me-123", startedAt: 10_000 }),
        "utf8",
      );

      const digests = await scanAppRunRegistry(appRoot);
      assert.equal(digests.length, 1);
      assert.equal(digests[0]!.runId, runId);
      assert.equal(digests[0]!.preset, "council");
      assert.equal(digests[0]!.stopReason, "completed");
    } finally {
      process.chdir(prev);
      await fs.rm(appRoot, { recursive: true, force: true });
    }
  });
});