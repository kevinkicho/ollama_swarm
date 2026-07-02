import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { providerGateway } from "./ProviderGateway.js";
import { __setTestProviderOverride, __resetProviderSingletons } from "./pickProvider.js";
import type { SessionProvider } from "./SessionProvider.js";

afterEach(() => {
  __resetProviderSingletons();
});

test("ProviderGateway.getHealth returns all provider slots", () => {
  const health = providerGateway.getHealth();
  assert.ok(health.ollama);
  assert.ok(health.anthropic);
  assert.equal(health.ollama.circuit, "closed");
});

test("ProviderGateway.chat delegates to pickProvider when gateway flag off", async () => {
  const provider: SessionProvider = {
    id: "ollama",
    async chat() {
      return { text: "ok", elapsedMs: 1, finishReason: "done" };
    },
  };
  __setTestProviderOverride(provider);
  const result = await providerGateway.chat({
    modelString: "test-model",
    messages: [{ role: "user", content: "hi" }],
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(result.text, "ok");
});