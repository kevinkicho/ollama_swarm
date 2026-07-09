import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRunSpawnModel } from "./resolveRunSpawnModel.js";
import type { RunConfig } from "./RunConfig.js";

const OPENCODE_TOPOLOGY = {
  agents: [
    { index: 1, role: "drafter" as const, provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash", removable: true },
    { index: 2, role: "drafter" as const, provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash", removable: true },
    { index: 3, role: "drafter" as const, provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash", removable: true },
  ],
};

function baseCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    agentCount: 3,
    rounds: 1,
    model: "deepseek-v4-flash:cloud",
    preset: "council",
    repoUrl: "https://github.com/test/repo",
    localPath: "/tmp/test",
    ...overrides,
  };
}

describe("resolveRunSpawnModel", () => {
  it("council honors topology when cfg.model is still :cloud default", () => {
    const cfg = baseCfg({ topology: OPENCODE_TOPOLOGY });
    assert.equal(resolveRunSpawnModel(cfg, 1), "opencode-go/deepseek-v4-flash");
    assert.equal(resolveRunSpawnModel(cfg, 2), "opencode-go/deepseek-v4-flash");
  });

  it("role-diff (round-robin) uses topology per peer index", () => {
    const cfg = baseCfg({
      preset: "role-diff",
      topology: {
        agents: [
          { index: 1, role: "role-diff", provider: "opencode", model: "opencode-go/glm-5.1", removable: true },
          { index: 2, role: "role-diff", provider: "opencode", model: "opencode-go/kimi-k2.5", removable: true },
        ],
      },
      agentCount: 2,
    });
    assert.equal(resolveRunSpawnModel(cfg, 1), "opencode-go/glm-5.1");
    assert.equal(resolveRunSpawnModel(cfg, 2), "opencode-go/kimi-k2.5");
  });

  it("orchestrator-worker-deep applies tier fallbacks when topology row is empty", () => {
    const cfg = baseCfg({
      preset: "orchestrator-worker-deep",
      agentCount: 4,
      orchestratorModel: "opencode-go/deepseek-v4-pro",
      workerModel: "opencode-go/deepseek-v4-flash",
      topology: {
        agents: [
          { index: 1, role: "orchestrator", removable: false },
          { index: 2, role: "mid-lead", removable: false },
          { index: 3, role: "worker", removable: true },
          { index: 4, role: "worker", removable: true },
        ],
      },
    });
    assert.equal(resolveRunSpawnModel(cfg, 1), "opencode-go/deepseek-v4-pro");
    assert.equal(resolveRunSpawnModel(cfg, 3), "opencode-go/deepseek-v4-flash");
  });

  it("map-reduce uses topology over reducer/mapper tier fallbacks", () => {
    const cfg = baseCfg({
      preset: "map-reduce",
      agentCount: 3,
      plannerModel: "glm-5.1:cloud",
      workerModel: "gemma4:31b-cloud",
      topology: {
        agents: [
          { index: 1, role: "reducer", provider: "opencode", model: "opencode-go/qwen3.7-max", removable: false },
          { index: 2, role: "mapper", provider: "opencode", model: "opencode-go/mimo-v2.5", removable: true },
          { index: 3, role: "mapper", provider: "opencode", model: "opencode-go/mimo-v2.5", removable: true },
        ],
      },
    });
    assert.equal(resolveRunSpawnModel(cfg, 1), "opencode-go/qwen3.7-max");
    assert.equal(resolveRunSpawnModel(cfg, 2), "opencode-go/mimo-v2.5");
  });
});