/**
 * Live Ollama Cloud model list via the same REST shape as local Ollama
 * (https://github.com/ollama/ollama/blob/main/docs/api.md — GET /api/tags).
 *
 * Cloud API host: https://ollama.com (docs.ollama.com/cloud).
 * Names returned by the API are **bare** model ids used in chat, e.g.
 *   glm-5.2, deepseek-v4-flash, gemma4:31b, gpt-oss:120b
 * Local Ollama cloud offload uses a :cloud / -cloud tag instead, e.g.
 *   glm-5.2:cloud, gemma4:31b-cloud, gpt-oss:120b-cloud
 *
 * Topology / detectProvider() need the local-style tag so provider routing
 * stays "ollama-cloud". OllamaCloudProvider strips the cloud suffix before
 * calling ollama.com.
 */

export const OLLAMA_CLOUD_TAGS_URL = "https://ollama.com/api/tags";

export interface DiscoverOllamaCloudOpts {
  /** Optional bearer key — tags is public today; key kept for future auth. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Convert an ollama.com API model name into the local-proxy tag form used
 * in RunConfig / topology (`:cloud` or `-cloud` suffix).
 */
export function toLocalCloudModelTag(apiName: string): string {
  const n = apiName.trim();
  if (!n) return n;
  if (/(?::|-)cloud$/i.test(n)) return n;
  // Size-tagged (model:120b, model:31b) → model:120b-cloud
  if (n.includes(":")) return `${n}-cloud`;
  // Bare name (glm-5.2) → glm-5.2:cloud
  return `${n}:cloud`;
}

/** Inverse of toLocalCloudModelTag for direct ollama.com chat. */
export function toOllamaCloudApiModelName(localOrApi: string): string {
  return localOrApi.trim().replace(/(?::|-)cloud$/i, "");
}

function parseTagNames(body: TagsResponse): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.models ?? []) {
    const raw = (m.name ?? m.model ?? "").trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Fetch cloud catalog from GET https://ollama.com/api/tags.
 * Returns local-style tags (`*:cloud` / `*-cloud`) for UI / detectProvider.
 * Null on network/HTTP failure so callers can use static fallback.
 */
export async function discoverOllamaCloudModels(
  opts: DiscoverOllamaCloudOpts = {},
): Promise<string[] | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    const headers: Record<string, string> = {};
    const key = opts.apiKey?.trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetchImpl(OLLAMA_CLOUD_TAGS_URL, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as TagsResponse;
    const apiNames = parseTagNames(body);
    if (apiNames.length === 0) return null;
    return apiNames.map(toLocalCloudModelTag);
  } catch {
    return null;
  }
}
