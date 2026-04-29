// Phase 1 of the multi-provider refactor (#314): model strings carry
// the provider in their prefix. Unprefixed → ollama (the historical
// default, so every existing call site stays correct).
//
//   "glm-5.1:cloud"               → ollama / glm-5.1:cloud
//   "anthropic/claude-opus-4-7"   → anthropic / claude-opus-4-7
//   "openai/gpt-5"                → openai / gpt-5
//
// Two surfaces consume these helpers:
//   1. RepoService.writeOpencodeConfig — groups models by provider and
//      emits one provider block per group.
//   2. The opencode SDK call sites (AgentManager.streamPrompt /
//      warmupAgent, BlackboardRunner planner/auditor invocations, etc.)
//      that need to pass `model: { providerID, modelID }` — they call
//      toOpenCodeModelRef(model) instead of hardcoding providerID.

export const PROVIDERS = ["ollama", "anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

const PROVIDER_PREFIX: Record<Provider, string> = {
  ollama: "",
  anthropic: "anthropic/",
  openai: "openai/",
};

export function detectProvider(model: string): Provider {
  if (model.startsWith("anthropic/")) return "anthropic";
  if (model.startsWith("openai/")) return "openai";
  return "ollama";
}

export function stripProviderPrefix(model: string): string {
  const provider = detectProvider(model);
  const prefix = PROVIDER_PREFIX[provider];
  return prefix ? model.slice(prefix.length) : model;
}

export function withProviderPrefix(provider: Provider, modelId: string): string {
  return PROVIDER_PREFIX[provider] + modelId;
}

// The shape the opencode SDK expects for every prompt / warmup call.
export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export function toOpenCodeModelRef(model: string): OpenCodeModelRef {
  return {
    providerID: detectProvider(model),
    modelID: stripProviderPrefix(model),
  };
}

// Hardcoded model lists for providers without a tags API. Ollama uses
// /api/tags discovery so it's not in this map; useAvailableModels falls
// back to these when the user picks a non-Ollama provider.
export const ANTHROPIC_MODELS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001",
] as const;

export const OPENAI_MODELS = [
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
] as const;

export function modelsForProvider(provider: Provider): readonly string[] {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_MODELS;
    case "openai":
      return OPENAI_MODELS;
    case "ollama":
      // Ollama models come from /api/tags at runtime; nothing to hardcode.
      return [];
  }
}
