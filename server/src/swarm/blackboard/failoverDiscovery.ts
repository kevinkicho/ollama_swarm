import type { FailoverConfig, FailoverState } from "../promptWithFailover.js";
import type { RunConfig } from "../SwarmRunner.js";
import { config as appConfig } from "../../config.js";

export interface FailoverDiscoveryContext {
  active?: RunConfig;
  localOllamaTags: readonly string[];
  setLocalOllamaTags: (v: string[]) => void;
  getOllamaBaseUrl: () => string | undefined;
}

export async function discoverLocalOllamaTags(ctx: FailoverDiscoveryContext): Promise<void> {
  try {
    const baseUrl = (ctx.getOllamaBaseUrl() ?? appConfig.OLLAMA_TAGS_FALLBACK_URL).replace(/\/v1\/?$/, "");
    const r = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return;
    const body = (await r.json()) as { models?: Array<{ name?: string }> };
    const tags = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    ctx.setLocalOllamaTags(tags);
  } catch {
    // discovery failed -> R3 stays disabled
  }
}

export function buildFailoverConfig(ctx: FailoverDiscoveryContext): FailoverConfig {
  const chain = ctx.active?.providerFailover ?? appConfig.SWARM_PROVIDER_FAILOVER;
  return {
    failoverChain: chain,
    localTags: appConfig.SWARM_DEGRADATION_FALLBACK ? ctx.localOllamaTags : [],
    localPreferred: appConfig.SWARM_DEGRADATION_PREFERRED,
    enableHealthSwap: appConfig.SWARM_MODEL_HEALTH_SWAP,
  };
}