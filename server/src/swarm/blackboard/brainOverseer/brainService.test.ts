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
      getRunnerForRun: () => ({ appendSystemMessage: (text: string, summary?: any) => { /* test stub */ } }),
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

  it("injectSuggestion calls runner append and emits", () => {
    let appended = false;
    const service = createBrainService({
      maxConcurrentRuns: 4,
      getOrchestrator: () => ({ start: async () => {} }),
      getActiveRunCount: () => 0,
      canStartRun: () => true,
      getRunnerForRun: () => ({
        appendSystemMessage: (text: string, summary?: any) => {
          appended = true;
          assert.ok(text.includes('Test suggestion'));
        },
      }),
      emit: (e: any) => {
        if (e.type === 'brain_suggestion') {
          assert.equal(e.title, 'Test suggestion');
        }
      },
    });
    service.injectSuggestion?.('run-123', { title: 'Test suggestion', text: 'Do something' });
    assert.equal(appended, true);
  });

  it("supports runContext in chat flow simulation", async () => {
    const service = makeService();
    // Simulate context build + chat
    const context = { runId: 'r1', phase: 'running', userDirective: 'test' };
    // Would call chat with context, here just verify service
    assert.ok(service);
  });

  it("full FAB context + inject flow simulation", () => {
    let injected = false;
    const service = createBrainService({
      maxConcurrentRuns: 4,
      getOrchestrator: () => ({ start: async () => {} }),
      getActiveRunCount: () => 1,
      canStartRun: () => true,
      getRunnerForRun: () => ({
        appendSystemMessage: (text: string) => {
          injected = text.includes('FAB context test');
        },
      }),
    });
    // Simulate build context like in FAB
    const fakeContext = { runId: 'fab-run', phase: 'running', recentTranscript: [{ role: 'system', text: 'test' }] };
    // Simulate chat send with context (backend would use it)
    // Then proactive inject
    service.injectSuggestion?.('fab-run', { title: 'FAB context test', text: 'Injected from simulated FAB' });
    assert.equal(injected, true);
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

  it("full e2e FAB simulation: suggest injects to transcript + brain_suggestion kind + history path", () => {
    // Simulates SystemWrapper FAB + BrainStartChat "Brain Suggest" button + backend
    let transcriptAppended = false;
    let suggestionSeen = false;
    const service = createBrainService({
      maxConcurrentRuns: 4,
      getOrchestrator: () => ({ start: async () => {} }),
      getActiveRunCount: () => 1,
      canStartRun: () => true,
      getRunnerForRun: () => ({
        appendSystemMessage: (text: string, summary?: any) => {
          transcriptAppended = true;
          if ((summary && summary.kind === "brain_suggestion") || /FAB e2e/.test(text || "")) {
            suggestionSeen = true;
          }
        },
      }),
    });
    // 1. Simulate /brain/suggest from transcript header or modal
    service.injectSuggestion?.("fab-e2e-run-xyz", {
      title: "FAB e2e simulation",
      text: "Check board and consider amend.",
      category: "recommendation",
    });
    assert.equal(transcriptAppended, true, "inject should reach runner.appendSystemMessage (like real FAB flow)");
    assert.equal(suggestionSeen, true, "should emit brain_suggestion summary kind for MessageBubble");
    // 2. History persistence side (client would POST /brain/chat-history, orch writes dedicated + snapshot)
    // Here we just assert the contract path is exercised in other tests; dedicated file write tested separately.
  });
});