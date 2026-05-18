import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectProvider, stripProviderPrefix } from "../../../shared/src/providers.js";
import { pickProvider, __resetProviderSingletons } from "./pickProvider.js";

// ---------------------------------------------------------------------------
// stripProviderPrefix & detectProvider — regression for key CRITICAL bug
// where "opencode-go/deepseek-v4-pro" was mangled to "go/deepseek-v4-pro"
// ---------------------------------------------------------------------------

describe("detectProvider — opencode prefixes", () => {
  it("detects opencode-go/ prefix models", () => {
    assert.equal(detectProvider("opencode-go/deepseek-v4-pro"), "opencode");
    assert.equal(detectProvider("opencode-go/glm-5.1"), "opencode");
    assert.equal(detectProvider("opencode-go/kimi-k2.6"), "opencode");
  });

  it("detects opencode-zen/ prefix models", () => {
    assert.equal(detectProvider("opencode-zen/glm-5.1"), "opencode");
    assert.equal(detectProvider("opencode-zen/deepseek-v4-pro"), "opencode");
  });

  it("detects opencode/ prefix models (Zen fallback)", () => {
    assert.equal(detectProvider("opencode/glm-5.1"), "opencode");
  });
});

describe("stripProviderPrefix — opencode Go/Zen prefix stripping (regression)", () => {
  it("correctly strips opencode-go/ prefix", () => {
    assert.equal(stripProviderPrefix("opencode-go/deepseek-v4-pro"), "deepseek-v4-pro");
    assert.equal(stripProviderPrefix("opencode-go/glm-5.1"), "glm-5.1");
    assert.equal(stripProviderPrefix("opencode-go/kimi-k2.6"), "kimi-k2.6");
    assert.equal(stripProviderPrefix("opencode-go/mimo-v2.5"), "mimo-v2.5");
    assert.equal(stripProviderPrefix("opencode-go/qwen3.5-plus"), "qwen3.5-plus");
  });

  it("correctly strips opencode-zen/ prefix", () => {
    assert.equal(stripProviderPrefix("opencode-zen/glm-5.1"), "glm-5.1");
    assert.equal(stripProviderPrefix("opencode-zen/deepseek-v4-pro"), "deepseek-v4-pro");
  });

  it("correctly strips opencode/ prefix", () => {
    assert.equal(stripProviderPrefix("opencode/glm-5.1"), "glm-5.1");
  });

  it("does NOT strip non-opencode prefixes that look similar", () => {
    assert.equal(stripProviderPrefix("openai/gpt-5"), "gpt-5");
    assert.equal(stripProviderPrefix("anthropic/claude-opus"), "claude-opus");
  });
});

// ---------------------------------------------------------------------------
// pickProvider — opencode routing
// ---------------------------------------------------------------------------

describe("pickProvider — opencode routing", () => {
  afterEach(() => {
    __resetProviderSingletons();
  });

  it("routes opencode-go/deepseek-v4-pro to opencode provider with FULL model string", () => {
    const result = pickProvider("opencode-go/deepseek-v4-pro");
    assert.equal(result.provider.id, "opencode");
    // Full model string is passed so OpenCodeProvider.route() can detect Go vs Zen
    assert.equal(result.modelId, "opencode-go/deepseek-v4-pro");
  });

  it("routes opencode-go/glm-5.1 to opencode provider", () => {
    const result = pickProvider("opencode-go/glm-5.1");
    assert.equal(result.provider.id, "opencode");
    assert.equal(result.modelId, "opencode-go/glm-5.1");
  });

  it("routes opencode-zen/glm-5.1 to opencode provider", () => {
    const result = pickProvider("opencode-zen/glm-5.1");
    assert.equal(result.provider.id, "opencode");
    assert.equal(result.modelId, "opencode-zen/glm-5.1");
  });

  it("reuses the same OpenCodeProvider singleton", () => {
    const a = pickProvider("opencode-go/deepseek-v4-pro");
    const b = pickProvider("opencode-go/glm-5.1");
    assert.strictEqual(a.provider, b.provider, "should reuse singleton");
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider response_format downgrade (unit-level, no API call)
// ---------------------------------------------------------------------------

describe("OpenCodeProvider — format downgrade", () => {
  // We cannot directly construct OpenCodeProvider without valid API keys
  // in config, but we can test the routing logic from pickProvider.
  // The actual format downgrade is tested indirectly through the provider
  // integration tests in OpenCodeProvider.integration.test.ts

  it("pickProvider correctly identifies opencode provider for all opencode-go models", () => {
    const models = [
      "opencode-go/glm-5.1",
      "opencode-go/glm-5",
      "opencode-go/kimi-k2.6",
      "opencode-go/kimi-k2.5",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/mimo-v2.5",
      "opencode-go/mimo-v2.5-pro",
      "opencode-go/minimax-m2.7",
      "opencode-go/minimax-m2.5",
      "opencode-go/qwen3.6-plus",
      "opencode-go/qwen3.5-plus",
    ];
    for (const m of models) {
      const result = pickProvider(m);
      assert.equal(result.provider.id, "opencode", `${m} should route to opencode`);
      assert.ok(result.modelId.startsWith("opencode-go/"), `${m} should keep full prefix in modelId`);
    }
  });
});
