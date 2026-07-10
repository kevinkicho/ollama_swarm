import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRunProvisioner } from "./provisioner.js";

describe("createRunProvisioner approve-to-provision", () => {
  it("refuses start when autoProvision is false and approved is not set", async () => {
    let started = 0;
    const p = createRunProvisioner({
      getOrchestrator: () => ({
        start: async () => {
          started++;
          return "run-1";
        },
      }),
      maxConcurrentRuns: 4,
      canStartRun: () => true,
      getActiveRunCount: () => 0,
      autoProvision: false,
    });
    const id = await p.startRunForProposal(
      { title: "t", description: "d" },
      "C:\\tmp\\clone",
    );
    assert.equal(id, null);
    assert.equal(started, 0);
    assert.equal(p.isAutoProvisionEnabled(), false);
  });

  it("starts when approved: true even if auto is off", async () => {
    let started = 0;
    const p = createRunProvisioner({
      getOrchestrator: () => ({
        start: async () => {
          started++;
          return "run-ok";
        },
      }),
      maxConcurrentRuns: 4,
      canStartRun: () => true,
      getActiveRunCount: () => 0,
      autoProvision: false,
    });
    const id = await p.startRunForProposal(
      { title: "t", description: "d" },
      process.cwd(),
      { approved: true },
    );
    assert.equal(id, "run-ok");
    assert.equal(started, 1);
  });

  it("starts without approved when autoProvision is true", async () => {
    let started = 0;
    const p = createRunProvisioner({
      getOrchestrator: () => ({
        start: async () => {
          started++;
          return "run-auto";
        },
      }),
      maxConcurrentRuns: 4,
      canStartRun: () => true,
      getActiveRunCount: () => 0,
      autoProvision: true,
    });
    const id = await p.startRunForProposal(
      { title: "t", description: "d" },
      process.cwd(),
    );
    assert.equal(id, "run-auto");
    assert.equal(started, 1);
  });
});
