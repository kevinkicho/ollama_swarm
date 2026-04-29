// E3 Phase 1 factory: given a model string (possibly provider-prefixed),
// return the right SessionProvider impl + the bare model id to call it
// with. Centralizes "which provider for this model?" so callers don't
// repeat detectProvider() everywhere.

import type { SessionProvider } from "./SessionProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";
import { AnthropicProvider } from "./AnthropicProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import { detectProvider, stripProviderPrefix } from "../../../shared/src/providers.js";

// Module-level singletons. Cheap to construct (no network at ctor
// time), but reusing avoids re-reading process.env on every call.
let ollamaSingleton: OllamaProvider | null = null;
let anthropicSingleton: AnthropicProvider | null = null;
let openaiSingleton: OpenAIProvider | null = null;

export interface PickedProvider {
  provider: SessionProvider;
  /** The bare model id to pass to provider.chat({ model }). */
  modelId: string;
}

export function pickProvider(modelString: string): PickedProvider {
  const which = detectProvider(modelString);
  const modelId = stripProviderPrefix(modelString);
  switch (which) {
    case "ollama":
      ollamaSingleton ??= new OllamaProvider();
      return { provider: ollamaSingleton, modelId };
    case "anthropic":
      anthropicSingleton ??= new AnthropicProvider();
      return { provider: anthropicSingleton, modelId };
    case "openai":
      openaiSingleton ??= new OpenAIProvider();
      return { provider: openaiSingleton, modelId };
  }
}

// Test seam: lets unit tests reset the singletons between cases (e.g.
// to swap the API key the AnthropicProvider was constructed with).
export function __resetProviderSingletons(): void {
  ollamaSingleton = null;
  anthropicSingleton = null;
  openaiSingleton = null;
}
