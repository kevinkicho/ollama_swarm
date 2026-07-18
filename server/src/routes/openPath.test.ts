import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSummaryStorageDirs } from "./openPath.js";

describe("resolveSummaryStorageDirs", () => {
  it("prefers clone/logs/<runId> when present", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "swarm-open-sum-"));
    try {
      const clone = path.join(root, "my-clone");
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      const perRun = path.join(clone, "logs", runId);
      mkdirSync(perRun, { recursive: true });
      writeFileSync(path.join(perRun, "summary.json"), "{}");
      const { primary } = await resolveSummaryStorageDirs(clone, runId);
      assert.equal(primary, path.resolve(perRun));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to clone/logs when per-run dir missing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "swarm-open-sum2-"));
    try {
      const clone = path.join(root, "my-clone");
      const logs = path.join(clone, "logs");
      mkdirSync(logs, { recursive: true });
      const { primary } = await resolveSummaryStorageDirs(clone, "deadbeef-0000");
      assert.equal(primary, path.resolve(logs));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
