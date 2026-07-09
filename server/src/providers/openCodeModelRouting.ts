// Per-model API routing for OpenCode Go + Zen.
// Source: https://opencode.ai/docs/go/ (same split applies to Zen tier URLs).

export type OpenCodeTier = "go" | "zen";
export type OpenCodeApiKind = "chat" | "messages";

/** Models that use Anthropic /v1/messages on OpenCode (Go + Zen). */
export const OPENCODE_MESSAGES_MODELS = new Set<string>([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
]);

/** Models documented on Go as OpenAI-compatible /v1/chat/completions. */
export const OPENCODE_CHAT_COMPLETIONS_MODELS = new Set<string>([
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
]);

export function openCodeApiKind(bareModel: string): OpenCodeApiKind {
  const id = bareModel.trim().toLowerCase();
  if (OPENCODE_MESSAGES_MODELS.has(id)) return "messages";
  if (OPENCODE_CHAT_COMPLETIONS_MODELS.has(id)) return "chat";
  // Heuristic for catalog models not yet in the static tables.
  if (/^qwen3\./.test(id)) return "messages";
  if (/^minimax-m/.test(id)) return "messages";
  return "chat";
}

export function openCodeEndpointUrl(tier: OpenCodeTier, api: OpenCodeApiKind): string {
  const root = tier === "go" ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1";
  return api === "messages" ? `${root}/messages` : `${root}/chat/completions`;
}

export interface OpenCodeRoute {
  tier: OpenCodeTier;
  bareModel: string;
  api: OpenCodeApiKind;
  url: string;
}

export function resolveOpenCodeRoute(model: string): OpenCodeRoute {
  let tier: OpenCodeTier = "zen";
  let bareModel = model;
  if (model.startsWith("opencode-go/")) {
    tier = "go";
    bareModel = model.slice("opencode-go/".length);
  } else {
    bareModel = model.replace(/^opencode(-zen)?\//, "");
  }
  const api = openCodeApiKind(bareModel);
  return { tier, bareModel, api, url: openCodeEndpointUrl(tier, api) };
}