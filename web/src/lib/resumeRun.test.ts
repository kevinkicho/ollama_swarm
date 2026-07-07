import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildResumeStartPayload,
  resolveResumeUserDirective,
  resumeParentPath,
} from "./resumeRun.js";

describe("resumeRun", () => {
  it("resumeParentPath uses clone dir for local workspace", () => {
    assert.equal(
      resumeParentPath("C:\\workspace\\my-project", ""),
      "C:\\workspace\\my-project",
    );
  });

  it("resumeParentPath uses parent when repoUrl is set", () => {
    assert.equal(
      resumeParentPath("C:\\workspace\\my-project", "https://github.com/o/r"),
      "C:\\workspace",
    );
  });

  it("buildResumeStartPayload from persisted runConfig extras", () => {
    const payload = buildResumeStartPayload({
      runConfig: {
        preset: "blackboard",
        repoUrl: "",
        localPath: "C:\\workspace\\superconducters_07062026",
        agentCount: 5,
        rounds: 0,
        model: "deepseek-v4-flash:cloud",
        extras: {
          plannerModel: "deepseek-v4-flash:cloud",
          workerModel: "deepseek-v4-flash:cloud",
          dedicatedAuditor: true,
          webTools: true,
          topology: { agents: [{ index: 1, role: "planner", model: "m", removable: false }] },
        },
      },
    });
    assert.ok(payload);
    assert.equal(payload!.preset, "blackboard");
    assert.equal(payload!.parentPath, "C:\\workspace\\superconducters_07062026");
    assert.equal(payload!.agentCount, 5);
    assert.equal(payload!.webTools, true);
    assert.equal(payload!.force, true);
  });

  it("resolveResumeUserDirective from runConfig extras", () => {
    const d = resolveResumeUserDirective({
      runConfig: { extras: { userDirective: "  Ship the CLI  " } },
    });
    assert.equal(d, "Ship the CLI");
  });

  it("resolveResumeUserDirective from top-level runConfig field", () => {
    const d = resolveResumeUserDirective({
      runConfig: { userDirective: "Add panels from gov data" },
    });
    assert.equal(d, "Add panels from gov data");
  });

  it("resolveResumeUserDirective from summary.userDirective", () => {
    const d = resolveResumeUserDirective({
      summary: { userDirective: "Migrate YAML state" } as any,
    });
    assert.equal(d, "Migrate YAML state");
  });

  it("resolveResumeUserDirective from summary.startCommand JSON", () => {
    const d = resolveResumeUserDirective({
      summary: {
        startCommand:
          "curl -X POST /api/swarm/start \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"userDirective\":\"Add panels from gov data\"}'",
      } as any,
    });
    assert.equal(d, "Add panels from gov data");
  });

  it("buildResumeStartPayload does not auto-resume council execution after crash", () => {
    const payload = buildResumeStartPayload({
      runConfig: {
        preset: "council",
        localPath: "C:\\workspace\\superconducters_07062026",
        agentCount: 4,
        rounds: 0,
        model: "deepseek-v4-flash:cloud",
        extras: { userDirective: "study superconductors" },
      },
      summary: {
        preset: "council",
        runId: "6cb20b27-9db7-4ef9-80e7-3a7934029f48",
        stopReason: "crash",
        localPath: "C:\\workspace\\superconducters_07062026",
        agentCount: 4,
      } as any,
    });
    assert.ok(payload);
    assert.equal((payload as { resumeExecutionFromRunId?: string }).resumeExecutionFromRunId, undefined);
  });

  it("buildResumeStartPayload carries userDirective and plannerTools", () => {
    const payload = buildResumeStartPayload({
      runConfig: {
        preset: "blackboard",
        localPath: "C:\\workspace\\proj",
        agentCount: 5,
        extras: {
          userDirective: "Migrate state from YAML configs",
          plannerTools: true,
          webTools: true,
        },
      },
    });
    assert.ok(payload);
    assert.equal(payload!.userDirective, "Migrate state from YAML configs");
    assert.equal(payload!.plannerTools, true);
    assert.equal(payload!.webTools, true);
  });
});