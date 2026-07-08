import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDuringRunSystemPrompt,
  buildRunSnapshotMarkdown,
  isProtectedInfraPath,
  isSwarmAppClone,
} from "./brainDuringRun.js";
import type { SwarmStatus } from "../types/run.js";

describe("brainDuringRun path guards", () => {
  it("flags swarm infrastructure paths", () => {
    assert.equal(isProtectedInfraPath("server/src/index.ts"), true);
    assert.equal(isProtectedInfraPath("web/src/App.tsx"), true);
    assert.equal(isProtectedInfraPath(".env"), true);
    assert.equal(isProtectedInfraPath("src/components/Foo.tsx"), false);
  });

  it("detects ollama_swarm repo layout", () => {
    assert.equal(isSwarmAppClone(process.cwd()), true);
  });
});

describe("buildRunSnapshotMarkdown", () => {
  it("renders markdown with run identity and transcript", () => {
    const status: SwarmStatus = {
      phase: "executing",
      round: 2,
      runId: "abc-123",
      runStartedAt: Date.now() - 60_000,
      agents: [{ id: "agent-1", index: 1, status: "thinking", model: "deepseek-v4-flash:cloud" }],
      transcript: [
        {
          id: "t1",
          role: "system",
          text: "run started",
          ts: Date.now(),
          summary: { kind: "run_start" } as any,
        },
      ],
      runConfig: {
        preset: "blackboard",
        plannerModel: "m1",
        workerModel: "m2",
        auditorModel: "m3",
        dedicatedAuditor: true,
        repoUrl: "",
        clonePath: "C:\\proj",
        agentCount: 5,
        rounds: 0,
      },
      board: {
        counts: { open: 1, claimed: 0, committed: 3, stale: 0 },
        todos: [{ id: "todo-1", description: "fix auth", status: "open" } as any],
      },
    };
    const md = buildRunSnapshotMarkdown(status);
    assert.match(md, /## Active run/);
    assert.match(md, /abc-123/);
    assert.match(md, /blackboard/);
    assert.match(md, /agent-1/);
    assert.match(md, /fix auth/);
  });
});

describe("buildDuringRunSystemPrompt", () => {
  it("includes markdown formatting instructions and snapshot", () => {
    const prompt = buildDuringRunSystemPrompt("## Active run\n- **Phase**: executing", true);
    assert.match(prompt, /Markdown/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /executing/);
  });
});