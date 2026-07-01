import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModels, type ModelDefaults, type ModelResolutionInput } from "../src/modelConfig.js";

const DEFAULTS: ModelDefaults = {
  model: "glm-5.1:cloud",
  workerModel: "gemma4:31b-cloud",
  auditorModel: "deepseek-v4-flash:cloud",
  dedicatedAuditor: true,
};

describe("resolveModels", () => {
  it("uses top-level model as catch-all when nothing else is set", () => {
    const result = resolveModels(
      { model: "opencode-go/deepseek-v4-pro", preset: "blackboard" },
      DEFAULTS,
    );
    assert.equal(result.model, "opencode-go/deepseek-v4-pro");
    assert.equal(result.plannerModel, "opencode-go/deepseek-v4-pro");
    assert.equal(result.workerModel, "gemma4:31b-cloud");
    assert.equal(result.auditorModel, "deepseek-v4-flash:cloud");
  });

  it("explicit plannerModel wins over model", () => {
    const result = resolveModels(
      {
        model: "opencode-go/deepseek-v4-pro",
        plannerModel: "glm-5.1:cloud",
        preset: "blackboard",
      },
      DEFAULTS,
    );
    assert.equal(result.plannerModel, "glm-5.1:cloud");
  });

  it("falls back to config defaults when model is unset", () => {
    const result = resolveModels(
      { preset: "blackboard" },
      DEFAULTS,
    );
    assert.equal(result.model, "glm-5.1:cloud");
    assert.equal(result.plannerModel, "glm-5.1:cloud");
    assert.equal(result.workerModel, "gemma4:31b-cloud");
    assert.equal(result.auditorModel, "deepseek-v4-flash:cloud");
  });

  it("non-blackboard presets share model for all roles", () => {
    const result = resolveModels(
      { model: "opencode-go/glm-5.1", preset: "council" },
      DEFAULTS,
    );
    assert.equal(result.plannerModel, "opencode-go/glm-5.1");
    assert.equal(result.workerModel, "opencode-go/glm-5.1");
    assert.equal(result.auditorModel, "opencode-go/glm-5.1");
  });

  it("topology planner model does NOT override explicit plannerModel", () => {
    const result = resolveModels(
      {
        model: "gemma4:31b-cloud",
        plannerModel: "opencode-go/deepseek-v4-pro",
        preset: "blackboard",
        topology: {
          agents: [
            { index: 1, role: "planner", removable: false, model: "glm-5.1:cloud" },
            { index: 2, role: "worker", removable: true },
          ],
        },
      },
      DEFAULTS,
    );
    assert.equal(result.plannerModel, "opencode-go/deepseek-v4-pro");
  });

  it("topology planner model is used as fallback when no explicit", () => {
    const result = resolveModels(
      {
        model: "gemma4:31b-cloud",
        preset: "blackboard",
        topology: {
          agents: [
            { index: 1, role: "planner", removable: false, model: "opencode-go/deepseek-v4-pro" },
            { index: 2, role: "worker", removable: true },
          ],
        },
      },
      DEFAULTS,
    );
    assert.equal(result.plannerModel, "opencode-go/deepseek-v4-pro");
  });

  it("auditor defaults to config default for blackboard with dedicated auditor", () => {
    const result = resolveModels(
      { model: "opencode-go/deepseek-v4-pro", preset: "blackboard", dedicatedAuditor: true },
      DEFAULTS,
    );
    assert.equal(result.auditorModel, "deepseek-v4-flash:cloud");
  });

  it("auditor is same as model for non-blackboard", () => {
    const result = resolveModels(
      { model: "opencode-go/deepseek-v4-pro", preset: "council" },
      DEFAULTS,
    );
    assert.equal(result.auditorModel, "opencode-go/deepseek-v4-pro");
  });
});
