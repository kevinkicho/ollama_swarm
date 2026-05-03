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
  OLLAMA_CLOUD_MODELS,
} from "./providers.js";

test("detectProvider — bare local model defaults to ollama", () => {
  assert.equal(detectProvider("llama3:8b"), "ollama");
  assert.equal(detectProvider("qwen2.5-coder:7b"), "ollama");
});

test("detectProvider — :cloud suffix → ollama-cloud", () => {
  assert.equal(detectProvider("glm-5.1:cloud"), "ollama-cloud");
  assert.equal(detectProvider("gemma4:31b-cloud"), "ollama-cloud");
  assert.equal(detectProvider("nemotron-3-super:cloud"), "ollama-cloud");
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
  // ollama and ollama-cloud both use empty prefix — round-trip relies on
  // detectProvider seeing the right marker (`:cloud` suffix vs no marker).
  const cases: Array<{ provider: "ollama" | "ollama-cloud" | "anthropic" | "openai"; model: string }> = [
    { provider: "ollama", model: "llama3:8b" },
    { provider: "ollama-cloud", model: "glm-5.1:cloud" },
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
  // ollama-cloud collapses to providerID="ollama" because the local
  // Ollama install handles routing for both local and :cloud models.
  assert.deepEqual(toOpenCodeModelRef("glm-5.1:cloud"), {
    providerID: "ollama",
    modelID: "glm-5.1:cloud",
  });
  assert.deepEqual(toOpenCodeModelRef("llama3:8b"), {
    providerID: "ollama",
    modelID: "llama3:8b",
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

test("modelsForProvider — paid providers return hardcoded lists; ollama-cloud returns its catalog; ollama returns empty", () => {
  assert.deepEqual(modelsForProvider("anthropic"), ANTHROPIC_MODELS);
  assert.deepEqual(modelsForProvider("openai"), OPENAI_MODELS);
  assert.deepEqual(modelsForProvider("ollama-cloud"), OLLAMA_CLOUD_MODELS);
  assert.deepEqual(modelsForProvider("ollama"), []);
});

test("OLLAMA_CLOUD_MODELS — every entry routes via ollama-cloud (matches :cloud or -cloud suffix)", () => {
  for (const m of OLLAMA_CLOUD_MODELS) {
    assert.ok(/(?::|-)cloud$/.test(m), `${m} must end with :cloud or -cloud`);
    assert.equal(detectProvider(m), "ollama-cloud");
  }
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
