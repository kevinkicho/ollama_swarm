// E3 Phase 1 factory: given a model string (possibly provider-prefixed),
// return the right SessionProvider impl + the bare model id to call it
// with. Centralizes "which provider for this model?" so callers don't
// repeat detectProvider() everywhere.

import type { SessionProvider } from "./SessionProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";
import { OllamaCloudProvider } from "./OllamaCloudProvider.js";
import { AnthropicProvider } from "./AnthropicProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import { OpenCodeProvider } from "./OpenCodeProvider.js";
import { detectProvider, stripProviderPrefix } from "../../../shared/src/providers.js";
import { config } from "../config.js";

let ollamaSingleton: OllamaProvider | null = null;
let ollamaCloudSingleton: OllamaCloudProvider | null = null;
let anthropicSingleton: AnthropicProvider | null = null;
let openaiSingleton: OpenAIProvider | null = null;
let opencodeSingleton: OpenCodeProvider | null = null;

// Test seam: when set, every pickProvider() call returns this provider
// regardless of the model string's prefix. Lets unit tests bypass the
// real OllamaProvider / AnthropicProvider / OpenAIProvider impls and
// inject deterministic behavior. Cleared via __resetProviderSingletons.
let testProviderOverride: SessionProvider | null = null;

export interface PickedProvider {
  provider: SessionProvider;
  /** The bare model id to pass to provider.chat({ model }). */
  modelId: string;
}

export function pickProvider(modelString: string): PickedProvider {
  const modelId = stripProviderPrefix(modelString);
  if (testProviderOverride) return { provider: testProviderOverride, modelId };
  const which = detectProvider(modelString);
  switch (which) {
    case "ollama":
      ollamaSingleton ??= new OllamaProvider();
      return { provider: ollamaSingleton, modelId };
    case "ollama-cloud":
      // When OLLAMA_CLOUD_API_KEY (or OLLAMA_API_KEY) is set, talk
      // directly to ollama.com — bypasses the local daemon. Otherwise
      // fall through to the local Ollama install which proxies cloud
      // models when the user has `ollama signin` configured.
      if (config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY) {
        ollamaCloudSingleton ??= new OllamaCloudProvider();
        return { provider: ollamaCloudSingleton, modelId };
      }
      ollamaSingleton ??= new OllamaProvider();
      return { provider: ollamaSingleton, modelId };
    case "anthropic":
      anthropicSingleton ??= new AnthropicProvider();
      return { provider: anthropicSingleton, modelId };
    case "openai":
      openaiSingleton ??= new OpenAIProvider();
      return { provider: openaiSingleton, modelId };
    case "opencode":
      opencodeSingleton ??= new OpenCodeProvider();
      // opencode models need the full prefix (opencode-go/ vs opencode-zen/)
      // intact so the provider can route to the correct endpoint. The provider
      // internally strips the prefix after routing.
      return { provider: opencodeSingleton, modelId: modelString };
  }
}

// Test seam: install a mock SessionProvider that overrides every
// pickProvider() result. Pair with __resetProviderSingletons() in
// afterEach to clear between cases.
export function __setTestProviderOverride(provider: SessionProvider | null): void {
  testProviderOverride = provider;
}

// Test seam: lets unit tests reset the singletons between cases (e.g.
// to swap the API key the AnthropicProvider was constructed with).
export function __resetProviderSingletons(): void {
  ollamaSingleton = null;
  ollamaCloudSingleton = null;
  anthropicSingleton = null;
  openaiSingleton = null;
  testProviderOverride = null;
}
