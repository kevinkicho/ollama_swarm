import { detectProvider, type Provider } from "@ollama-swarm/shared/providers";
import { config } from "../config.js";

export interface ProviderKeyWarning {
  provider: Provider;
  model: string;
  envVar: string;
  message: string;
}

const KEY_ENV: Partial<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

function hasProviderKey(provider: Provider): boolean {
  switch (provider) {
    case "ollama":
    case "ollama-cloud":
      return true;
    case "anthropic":
      return !!config.ANTHROPIC_API_KEY;
    case "openai":
      return !!config.OPENAI_API_KEY;
    case "opencode":
      return !!(
        config.OPENCODE_GO_API_KEY ||
        config.OPENCODE_ZEN_API_KEY ||
        config.OPENCODE_API_KEY
      );
  }
}

/** Return actionable warnings for models that need API keys not set in env. */
export function missingProviderKeysForModels(models: string[]): ProviderKeyWarning[] {
  const seen = new Set<string>();
  const out: ProviderKeyWarning[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const provider = detectProvider(trimmed);
    if (provider === "ollama" || provider === "ollama-cloud") continue;
    if (hasProviderKey(provider)) continue;
    const envVar = KEY_ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`;
    out.push({
      provider,
      model: trimmed,
      envVar,
      message: `Missing ${envVar} for ${provider} model "${trimmed}"`,
    });
  }
  return out;
}