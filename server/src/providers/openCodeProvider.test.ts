import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectProvider, stripProviderPrefix } from "@ollama-swarm/shared/providers";
import { pickProvider, __resetProviderSingletons } from "./pickProvider.js";
import { formatOpenCodeHttpError } from "./OpenCodeProvider.js";
import {
  openCodeApiKind,
  openCodeEndpointUrl,
  resolveOpenCodeRoute,
} from "./openCodeModelRouting.js";

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
      "opencode-go/glm-5.2",
      "opencode-go/glm-5.1",
      "opencode-go/kimi-k2.7-code",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/minimax-m3",
      "opencode-go/qwen3.7-plus",
    ];
    for (const m of models) {
      const result = pickProvider(m);
      assert.equal(result.provider.id, "opencode", `${m} should route to opencode`);
      assert.ok(result.modelId.startsWith("opencode-go/"), `${m} should keep full prefix in modelId`);
    }
  });
});

describe("openCodeModelRouting", () => {
  it("routes chat/completions models on Go tier", () => {
    const route = resolveOpenCodeRoute("opencode-go/deepseek-v4-flash");
    assert.equal(route.tier, "go");
    assert.equal(route.api, "chat");
    assert.equal(route.bareModel, "deepseek-v4-flash");
    assert.equal(route.url, "https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("routes messages models on Go tier", () => {
    const route = resolveOpenCodeRoute("opencode-go/qwen3.6-plus");
    assert.equal(route.tier, "go");
    assert.equal(route.api, "messages");
    assert.equal(route.bareModel, "qwen3.6-plus");
    assert.equal(route.url, "https://opencode.ai/zen/go/v1/messages");
  });

  it("routes messages models on Zen tier", () => {
    const route = resolveOpenCodeRoute("opencode-zen/minimax-m2.7");
    assert.equal(route.tier, "zen");
    assert.equal(route.api, "messages");
    assert.equal(route.url, "https://opencode.ai/zen/v1/messages");
  });

  it("routes chat/completions models on Zen tier via opencode/ prefix", () => {
    const route = resolveOpenCodeRoute("opencode/glm-5.1");
    assert.equal(route.tier, "zen");
    assert.equal(route.api, "chat");
    assert.equal(route.url, "https://opencode.ai/zen/v1/chat/completions");
  });

  it("classifies all documented Go models per opencode.ai/docs/go", () => {
    const chatModels = [
      "grok-4.5",
      "glm-5.2",
      "glm-5.1",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "mimo-v2.5",
      "mimo-v2.5-pro",
    ];
    const messagesModels = [
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
    ];
    for (const m of chatModels) {
      assert.equal(openCodeApiKind(m), "chat", `${m} should use chat/completions`);
      assert.equal(
        openCodeEndpointUrl("go", "chat"),
        "https://opencode.ai/zen/go/v1/chat/completions",
      );
    }
    for (const m of messagesModels) {
      assert.equal(openCodeApiKind(m), "messages", `${m} should use /messages`);
      assert.equal(
        openCodeEndpointUrl("zen", "messages"),
        "https://opencode.ai/zen/v1/messages",
      );
    }
  });
});

describe("formatOpenCodeHttpError", () => {
  it("maps Zen insufficient balance to actionable message", () => {
    const msg = formatOpenCodeHttpError(
      401,
      JSON.stringify({ error: { type: "CreditsError", message: "Insufficient balance" } }),
      "zen",
      "https://opencode.ai/zen/v1/chat/completions",
    );
    assert.match(msg, /Zen balance depleted/i);
    assert.match(msg, /opencode-go/i);
  });

  it("maps Go 429 to subscription limit message", () => {
    const msg = formatOpenCodeHttpError(429, "", "go", "https://opencode.ai/zen/go/v1/chat/completions");
    assert.match(msg, /Go subscription limit/i);
  });
});
