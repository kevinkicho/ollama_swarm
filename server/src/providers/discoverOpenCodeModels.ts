/** Live model lists from OpenCode (https://opencode.ai/docs/go/). */

export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

export interface DiscoverOpenCodeOpts {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenCodeModelsResponse {
  data?: Array<{ id?: string }>;
}

function parseOpenCodeModelIds(body: OpenCodeModelsResponse): string[] {
  return (body.data ?? [])
    .map((m) => m.id?.trim())
    .filter((id): id is string => !!id);
}

async function fetchOpenCodeModelIds(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[] | null> {
  try {
    const r = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as OpenCodeModelsResponse;
    const ids = parseOpenCodeModelIds(body);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** Go subscription models — prefixed `opencode-go/<id>`. */
export async function discoverOpenCodeGoModels(
  opts: DiscoverOpenCodeOpts = {},
): Promise<string[] | null> {
  const key = opts.apiKey?.trim();
  if (!key) return null;
  const ids = await fetchOpenCodeModelIds(
    OPENCODE_GO_MODELS_URL,
    key,
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 8000,
  );
  return ids ? ids.map((id) => `opencode-go/${id}`) : null;
}

/** Zen pay-as-you-go models — prefixed `opencode/<id>`. */
export async function discoverOpenCodeZenModels(
  opts: DiscoverOpenCodeOpts = {},
): Promise<string[] | null> {
  const key = opts.apiKey?.trim();
  if (!key) return null;
  const ids = await fetchOpenCodeModelIds(
    OPENCODE_ZEN_MODELS_URL,
    key,
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 8000,
  );
  return ids ? ids.map((id) => `opencode/${id}`) : null;
}

export interface DiscoverAllOpenCodeOpts {
  goApiKey?: string;
  zenApiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Merged Go + Zen lists for the OpenCode provider tab (Go models first). */
export async function discoverOpenCodeModels(
  opts: DiscoverAllOpenCodeOpts = {},
): Promise<string[] | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const goKey = opts.goApiKey?.trim();
  const zenKey = opts.zenApiKey?.trim();

  const [goModels, zenModels] = await Promise.all([
    goKey
      ? discoverOpenCodeGoModels({ apiKey: goKey, fetchImpl, timeoutMs })
      : Promise.resolve(null),
    zenKey
      ? discoverOpenCodeZenModels({ apiKey: zenKey, fetchImpl, timeoutMs })
      : Promise.resolve(null),
  ]);

  if (!goModels?.length && !zenModels?.length) return null;

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const m of [...(goModels ?? []), ...(zenModels ?? [])]) {
    if (seen.has(m)) continue;
    seen.add(m);
    merged.push(m);
  }
  return merged;
}