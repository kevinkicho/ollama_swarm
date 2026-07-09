import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { status } from "./statusBuilder.js";
import type { RunConfig } from "../SwarmRunner.js";

const BASE_CFG: RunConfig = {
  agentCount: 2,
  rounds: 3,
  model: "test-model",
  preset: "blackboard",
  repoUrl: "https://github.com/test/repo",
  localPath: "/tmp/test-repo",
  webTools: true,
  plannerTools: false,
  mcpServers: "github",
  userDirective: "  find endpoints  ",
};

function minimalCtx(active?: RunConfig) {
  return {
    phase: "executing",
    round: 1,
    active,
    transcript: [],
    recentLatencySamples: new Map(),
    cloneContract: (c: unknown) => c,
    agentStates: () => [],
    getPartialStreams: () => ({}),
    utilCtx: () =>
      ({
        todoQueue: { list: () => [], counts: () => ({}) },
        findings: { list: () => [] },
      }) as never,
  };
}

describe("statusBuilder", () => {
  it("includes webTools and other tooling fields in runConfig", () => {
    const snap = status(minimalCtx(BASE_CFG));
    assert.equal(snap.runConfig?.webTools, true);
    assert.equal(snap.runConfig?.plannerTools, false);
    assert.equal(snap.runConfig?.mcpServers, "github");
    assert.equal(snap.runConfig?.userDirective, "find endpoints");
  });

  it("omits runConfig when no active cfg", () => {
    const snap = status(minimalCtx(undefined));
    assert.equal(snap.runConfig, undefined);
  });
});