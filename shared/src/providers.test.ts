import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectProvider,
  stripProviderPrefix,
  withProviderPrefix,
  toOpenCodeModelRef,
  modelsForProvider,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
} from "./providers.js";

test("detectProvider — bare model defaults to ollama", () => {
  assert.equal(detectProvider("glm-5.1:cloud"), "ollama");
  assert.equal(detectProvider("gemma4:31b-cloud"), "ollama");
  assert.equal(detectProvider("nemotron-3-super:cloud"), "ollama");
});

test("detectProvider — anthropic prefix", () => {
  assert.equal(detectProvider("anthropic/claude-opus-4-7"), "anthropic");
  assert.equal(detectProvider("anthropic/claude-haiku-4-5-20251001"), "anthropic");
});

test("detectProvider — openai prefix", () => {
  assert.equal(detectProvider("openai/gpt-5"), "openai");
  assert.equal(detectProvider("openai/gpt-5-nano"), "openai");
});

test("stripProviderPrefix — ollama is unchanged", () => {
  assert.equal(stripProviderPrefix("glm-5.1:cloud"), "glm-5.1:cloud");
});

test("stripProviderPrefix — strips anthropic/ and openai/", () => {
  assert.equal(stripProviderPrefix("anthropic/claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(stripProviderPrefix("openai/gpt-5"), "gpt-5");
});

test("withProviderPrefix — round-trips through stripProviderPrefix", () => {
  const cases: Array<{ provider: "ollama" | "anthropic" | "openai"; model: string }> = [
    { provider: "ollama", model: "glm-5.1:cloud" },
    { provider: "anthropic", model: "claude-opus-4-7" },
    { provider: "openai", model: "gpt-5" },
  ];
  for (const { provider, model } of cases) {
    const prefixed = withProviderPrefix(provider, model);
    assert.equal(stripProviderPrefix(prefixed), model);
    assert.equal(detectProvider(prefixed), provider);
  }
});

test("toOpenCodeModelRef — produces SDK-shaped { providerID, modelID }", () => {
  assert.deepEqual(toOpenCodeModelRef("glm-5.1:cloud"), {
    providerID: "ollama",
    modelID: "glm-5.1:cloud",
  });
  assert.deepEqual(toOpenCodeModelRef("anthropic/claude-opus-4-7"), {
    providerID: "anthropic",
    modelID: "claude-opus-4-7",
  });
  assert.deepEqual(toOpenCodeModelRef("openai/gpt-5"), {
    providerID: "openai",
    modelID: "gpt-5",
  });
});

test("modelsForProvider — anthropic and openai return their hardcoded lists; ollama returns empty", () => {
  assert.deepEqual(modelsForProvider("anthropic"), ANTHROPIC_MODELS);
  assert.deepEqual(modelsForProvider("openai"), OPENAI_MODELS);
  assert.deepEqual(modelsForProvider("ollama"), []);
});

test("ANTHROPIC_MODELS and OPENAI_MODELS — every entry is provider-prefixed", () => {
  for (const m of ANTHROPIC_MODELS) {
    assert.ok(m.startsWith("anthropic/"), `${m} must start with anthropic/`);
    assert.equal(detectProvider(m), "anthropic");
  }
  for (const m of OPENAI_MODELS) {
    assert.ok(m.startsWith("openai/"), `${m} must start with openai/`);
    assert.equal(detectProvider(m), "openai");
  }
});
