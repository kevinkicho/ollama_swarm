import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetSystemLayerSettingsForTests,
  getSystemLayerSettingsPayload,
  resolveSystemLayerModel,
  setSystemLayerUiModel,
} from "./systemLayerSettings.js";

describe("systemLayerSettings", () => {
  beforeEach(() => {
    __resetSystemLayerSettingsForTests();
  });

  it("uses UI model for Brain when no per-request override", () => {
    setSystemLayerUiModel("opencode-go/deepseek-v4-flash");
    const resolved = resolveSystemLayerModel();
    assert.equal(resolved.modelString, "opencode-go/deepseek-v4-flash");
    assert.equal(resolved.source, "ui");
    assert.equal(resolved.provider, "opencode");
  });

  it("per-request model wins over UI setting", () => {
    setSystemLayerUiModel("opencode-go/glm-5.1");
    const resolved = resolveSystemLayerModel("anthropic/claude-haiku-4-5");
    assert.equal(resolved.modelString, "anthropic/claude-haiku-4-5");
    assert.equal(resolved.source, "request");
  });

  it("getSystemLayerSettingsPayload exposes ui override", () => {
    setSystemLayerUiModel("opencode-go/deepseek-v4-pro");
    const payload = getSystemLayerSettingsPayload();
    assert.equal(payload.uiOverride, "opencode-go/deepseek-v4-pro");
    assert.equal(payload.activeModel, "opencode-go/deepseek-v4-pro");
    assert.equal(payload.activeProvider, "opencode");
  });
});