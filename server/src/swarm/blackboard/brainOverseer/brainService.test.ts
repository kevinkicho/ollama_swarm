import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBrainService, appendProposal } from "./brainService.js";

describe("brainService", () => {
  let tmpDir = "";

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-service-"));
  });

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeService(activeRuns = 0, startInProgress = false) {
    return createBrainService({
      maxConcurrentRuns: 4,
      getOrchestrator: () => ({ start: async () => {} }),
      getActiveRunCount: () => activeRuns,
      canStartRun: () => !startInProgress && activeRuns < 4,
    });
  }

  it("getAllProposals returns pending proposals for a clone path", async () => {
    const service = makeService();
    service.registerClonePath(tmpDir);
    const persisted = await appendProposal(tmpDir, {
      title: "Fix retry loop",
      description: "Backoff on transient errors",
      affectedComponent: "WorkerPipeline",
      priority: "high",
    });
    const proposals = await service.getAllProposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.id, persisted.id);
    assert.equal(proposals[0]?.status, "pending");
  });

  it("rejectProposal marks a proposal rejected on disk", async () => {
    const rejectDir = path.join(tmpDir, "reject-case");
    await fs.mkdir(rejectDir, { recursive: true });
    const service = makeService();
    service.registerClonePath(rejectDir);
    const persisted = await appendProposal(rejectDir, {
      title: "Reject me",
      description: "Not worth doing",
      affectedComponent: "UI",
      priority: "low",
    });
    const result = await service.rejectProposal(persisted.id, "out of scope");
    assert.equal(result.success, true);
    const remaining = await service.getAllProposals(rejectDir);
    assert.equal(remaining.length, 0);
    const activities = service.getRecentActivities();
    assert.ok(activities.some((a) => a.title.includes("Dismissed insight")));
  });

  // applyProposal was removed (Brain no longer does system self-patching).
  // Test kept as skipped documentation of historical behavior.
  it.skip("applyProposal refuses when runs are active (removed feature)", async () => {
    // intentionally skipped
  });

  it("tracks activities and exposes them via getRecentActivities", async () => {
    const activityDir = path.join(tmpDir, "activity-case");
    await fs.mkdir(activityDir, { recursive: true });
    const service = makeService();
    service.registerClonePath(activityDir);
    const persisted = await appendProposal(activityDir, {
      title: "Activity test",
      description: "Ensure timeline works",
      affectedComponent: "brain",
      priority: "low",
    });
    await service.rejectProposal(persisted.id, "test");
    const activities = service.getRecentActivities();
    assert.ok(activities.length > 0);
    assert.equal(activities[0]?.type, "proposal");
  });
});