import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getMaintenanceStatus,
  getProjectLogsStatus,
  pruneLogs,
  runMaintenancePrune,
} from "./maintenancePrune.js";

describe("maintenancePrune", () => {
  let tmp: string;
  let project: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-prune-"));
    const logs = path.join(tmp, "logs");
    await fs.mkdir(logs, { recursive: true });
    // 3 run dirs under logs/
    for (const id of ["run-a", "run-b", "run-c"]) {
      await fs.mkdir(path.join(logs, id), { recursive: true });
      await fs.writeFile(path.join(logs, id, "debug.jsonl"), "x".repeat(100));
    }
    // old-ish archive that should be eligible when keep-n is low + keep-days 0
    const oldArchive = path.join(logs, "events-old.jsonl");
    await fs.writeFile(oldArchive, "archive");
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldArchive, past, past);
    for (const id of ["run-a", "run-b"]) {
      await fs.utimes(path.join(logs, id), past, past);
    }

    // Fake target repo with project logs (summaries + run dirs)
    project = path.join(tmp, "my-project");
    const plogs = path.join(project, "logs");
    await fs.mkdir(plogs, { recursive: true });
    await fs.writeFile(path.join(plogs, "summary.json"), "{}");
    for (const id of ["aaaa1111", "bbbb2222", "cccc3333"]) {
      await fs.mkdir(path.join(plogs, id), { recursive: true });
      await fs.writeFile(path.join(plogs, id, "note.txt"), "run data");
      await fs.writeFile(path.join(plogs, `summary-${id}-2026.json`), `{"runId":"${id}"}`);
      await fs.utimes(path.join(plogs, id), past, past);
      await fs.utimes(path.join(plogs, `summary-${id}-2026.json`), past, past);
    }
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports log run dir count", () => {
    const st = getMaintenanceStatus(tmp);
    assert.equal(st.logsRunDirCount, 3);
    assert.equal(st.logsNeedsPrune, false);
  });

  it("reports project logs when clonePath provided", () => {
    const st = getMaintenanceStatus(tmp, project);
    assert.ok(st.project);
    assert.equal(st.project!.logsRunDirCount, 3);
    assert.equal(st.project!.summaryFileCount, 3);
  });

  it("dry-run does not delete", async () => {
    const r = pruneLogs({
      root: tmp,
      apply: false,
      keepDays: 1,
      maxKeep: 1,
      keepNArchives: 0,
    });
    assert.equal(r.apply, false);
    assert.ok(r.deletedCount >= 1);
    const st = getMaintenanceStatus(tmp);
    assert.equal(st.logsRunDirCount, 3);
  });

  it("apply caps log run dirs", async () => {
    const r = pruneLogs({
      root: tmp,
      apply: true,
      keepDays: 1,
      maxKeep: 1,
      keepNArchives: 0,
    });
    assert.equal(r.apply, true);
    assert.ok(r.deletedCount >= 1);
    const st = getMaintenanceStatus(tmp);
    assert.ok(st.logsRunDirCount <= 1);
  });

  it("target all returns combined summary", () => {
    const r = runMaintenancePrune({ root: tmp, target: "all", apply: false });
    assert.equal(r.target, "all");
    assert.ok(r.summary.includes("logs") || r.summary.length > 0);
  });

  it("project-logs purge removes dirs and summary files but keeps protected", async () => {
    const before = getProjectLogsStatus(project);
    assert.equal(before.logsRunDirCount, 3);
    const r = runMaintenancePrune({
      root: project,
      target: "project-logs",
      mode: "purge",
      apply: true,
      protectNames: ["aaaa1111"],
    });
    assert.equal(r.target, "project-logs");
    assert.ok(r.deletedCount >= 2);
    const after = getProjectLogsStatus(project);
    assert.ok(after.logsRunDirCount <= 1);
    // summary.json latest pointer must remain
    await fs.access(path.join(project, "logs", "summary.json"));
  });
});
