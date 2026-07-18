// Phase 1 of the multi-provider refactor (#314): model strings carry
// the provider in their prefix. Unprefixed → ollama (the historical
// default, so every existing call site stays correct).
//
//   "glm-5.1:cloud"               → ollama-cloud / glm-5.1:cloud
//   "llama3:8b"                   → ollama / llama3:8b   (no :cloud suffix)
//   "anthropic/claude-opus-4-7"   → anthropic / claude-opus-4-7
//   "openai/gpt-5"                → openai / gpt-5
//
// 2026-05-03: added "ollama-cloud" as a UI-distinct provider. Server
// routing still goes through the local Ollama install (which proxies
// `:cloud`-suffixed models to ollama.com when OLLAMA_API_KEY is set
// per https://docs.ollama.com/cloud) — so toOpenCodeModelRef + the
// SDK call sites use providerID="ollama" for cloud models too. The
// distinction is purely for the form's selection UX so users can pick
// from the curated cloud catalog vs their locally-pulled tags.
//
// Two surfaces consume these helpers:
//   1. RepoService.writeOpencodeConfig — groups models by provider and
//      emits one provider block per group.
//   2. The opencode SDK call sites (AgentManager.streamPrompt /
//      warmupAgent, BlackboardRunner planner/auditor invocations, etc.)
//      that need to pass `model: { providerID, modelID }` — they call
//      toOpenCodeModelRef(model) instead of hardcoding providerID.

export const PROVIDERS = ["ollama", "ollama-cloud", "anthropic", "openai", "opencode"] as const;
export type Provider = (typeof PROVIDERS)[number];

const PROVIDER_PREFIX: Record<Provider, string> = {
  ollama: "",
  "ollama-cloud": "",
  anthropic: "anthropic/",
  openai: "openai/",
  opencode: "opencode/",
};

export function detectProvider(model: string): Provider {
  if (model.startsWith("anthropic/")) return "anthropic";
  if (model.startsWith("openai/")) return "openai";
  // OpenCode Go: opencode-go/ prefix; Zen: opencode/ prefix
  if (model.startsWith("opencode-go/") || model.startsWith("opencode-zen/") || model.startsWith("opencode/")) return "opencode";
  // 2026-05-03: cloud-tag suffix → Ollama Cloud. Two shapes are in
  // use on ollama.com: bare ":cloud" (e.g. glm-5.1:cloud) and
  // size-tagged "...b-cloud" or "...m-cloud" (e.g. gemma4:31b-cloud,
  // gemma4:26b-cloud, ministral-3:7m-cloud). Match both — they
  // always sit at the end and the local-tag namespace ("llama3:8b")
  // never ends in -cloud so this stays unambiguous.
  if (/(?::|-)cloud$/.test(model)) return "ollama-cloud";
  return "ollama";
}

export function stripProviderPrefix(model: string): string {
  const provider = detectProvider(model);
  const prefix = PROVIDER_PREFIX[provider];
  if (!prefix) return model;
  // opencode-go/ and opencode-zen/ are longer than opencode/ — strip
  // the actual full prefix instead of blindly slicing the base prefix.
  if (provider === "opencode") {
    return model.replace(/^opencode(-go|-zen)?\//, "");
  }
  return model.slice(prefix.length);
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
  // 2026-05-03: collapse "ollama-cloud" → "ollama" for the SDK ref.
  // ollama-cloud is a UI-only distinction — at runtime the local
  // Ollama install handles both local tags and `:cloud` models (it
  // proxies the latter to ollama.com transparently). Only the form
  // catalog needs to differentiate; provider IDs registered with the
  // SDK / OllamaProvider use the singular "ollama" id.
  const detected = detectProvider(model);
  const providerID = detected === "ollama-cloud" ? "ollama" : detected;
  return {
    providerID,
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

// Ollama Cloud fallback catalog for topology when live discovery fails.
// API names come from GET https://ollama.com/api/tags (docs.ollama.com/cloud
// + github.com/ollama/ollama/blob/main/docs/api.md). Those bare names are
// mapped to local-proxy tags (:cloud / -cloud) for detectProvider routing;
// OllamaCloudProvider strips the suffix before calling ollama.com.
// Live list: server discoverOllamaCloudModels() → /api/models?provider=ollama-cloud
// Last synced from ollama.com/api/tags: 2026-07-17.
export const OLLAMA_CLOUD_MODELS = [
  // Bare API → :cloud
  "glm-5.2:cloud",
  "glm-5.1:cloud",
  "kimi-k2.7-code:cloud",
  "kimi-k2.6:cloud",
  "kimi-k2.5:cloud",
  "deepseek-v4-pro:cloud",
  "deepseek-v4-flash:cloud",
  "minimax-m3:cloud",
  "minimax-m2.7:cloud",
  "minimax-m2.5:cloud",
  "nemotron-3-ultra:cloud",
  "nemotron-3-super:cloud",
  // Size-tagged API → -cloud
  "nemotron-3-nano:30b-cloud",
  "qwen3.5:397b-cloud",
  "gemma4:31b-cloud",
  "gpt-oss:120b-cloud",
  "gpt-oss:20b-cloud",
  "mistral-large-3:675b-cloud",
] as const;

/** Topology row shape needed to resolve a routable model id. */
export interface AgentModelPin {
  provider?: Provider;
  model?: string;
}

/**
 * Effective model string for one agent row. Honors per-agent `provider`
 * when the model (or fallback) would route elsewhere — e.g. provider=opencode
 * with an empty override must not fall back to a `:cloud` default.
 */
export function resolveModelForAgent(agent: AgentModelPin, fallbackModel: string): string {
  const provider = agent.provider;
  const explicit = agent.model?.trim();

  if (!provider) {
    return explicit && explicit.length > 0 ? explicit : fallbackModel;
  }

  const seed = explicit && explicit.length > 0 ? explicit : fallbackModel;
  if (seed.length > 0 && detectProvider(seed) === provider) {
    return seed;
  }

  const catalog = modelsForProvider(provider);
  if (explicit && explicit.length > 0) {
    const bare = stripProviderPrefix(explicit);
    const mapped = catalog.find(
      (m) =>
        stripProviderPrefix(m) === bare ||
        m.endsWith(`/${bare}`) ||
        bare.endsWith(stripProviderPrefix(m)),
    );
    if (mapped) return mapped;
  }
  if (catalog.length > 0) {
    return catalog[0]!;
  }
  return seed.length > 0 ? seed : fallbackModel;
}

export function modelsForProvider(provider: Provider): readonly string[] {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_MODELS;
    case "openai":
      return OPENAI_MODELS;
    case "ollama-cloud":
      return OLLAMA_CLOUD_MODELS;
    case "ollama":
      return [];
    case "opencode":
      return OPENCODE_GO_MODELS;
  }
}

// OpenCode Go — fallback catalog when live discovery is unavailable.
// Source of truth: https://opencode.ai/docs/go/ + GET /zen/go/v1/models.
// Server may replace with the live list when OPENCODE_GO_API_KEY is set.
// Last synced: 2026-07-17 (live /zen/go/v1/models + docs endpoint table).
export const OPENCODE_GO_MODELS = [
  // Docs “current list” order (primary picks for topology)
  "opencode-go/grok-4.5",
  "opencode-go/glm-5.2",
  "opencode-go/glm-5.1",
  "opencode-go/kimi-k3",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k2.6",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m3",
  "opencode-go/minimax-m2.7",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "opencode-go/qwen3.6-plus",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash",
  // Still on the live Go models API (kept for discovery parity)
  "opencode-go/glm-5",
  "opencode-go/kimi-k2.5",
  "opencode-go/minimax-m2.5",
  "opencode-go/qwen3.5-plus",
  "opencode-go/mimo-v2-pro",
  "opencode-go/mimo-v2-omni",
  "opencode-go/hy3-preview",
] as const;
