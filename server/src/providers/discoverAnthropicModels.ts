// 2026-05-03: live discovery of Anthropic models via /v1/models.
// Pre-fix the SetupForm only had hardcoded ANTHROPIC_MODELS in
// shared/src/providers.ts (3 entries) which goes stale every model
// release. With this discovery, the form's autocomplete reflects
// what THIS API key actually has access to.
//
// Returns prefixed strings ("anthropic/claude-opus-4-7") to match
// the shape ModelInput's <datalist> already consumes — so callers
// don't need to re-prefix. Failures (no key, network down,
// unexpected response) return null; the route caller falls back
// to the hardcoded list.

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";

export interface AnthropicModelEntry {
  id: string;
  display_name?: string;
  created_at?: string;
}

export interface AnthropicModelsResponse {
  data?: AnthropicModelEntry[];
}

/** Fetch the model list from Anthropic. Returns prefixed model ids
 *  ("anthropic/<id>") sorted by created_at desc (newest first) so
 *  the form's autocomplete surfaces the most recent model first.
 *  Returns null on any failure — caller is responsible for falling
 *  back to the hardcoded list. */
export async function discoverAnthropicModels(opts?: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<readonly string[] | null> {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey.length === 0) return null;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  try {
    const r = await fetchImpl(ANTHROPIC_MODELS_URL, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as AnthropicModelsResponse;
    return parseAnthropicModels(body);
  } catch {
    return null;
  }
}

/** Pure parser — exported for tests. Sorts by created_at desc and
 *  prefixes each id with "anthropic/" to match the shape the form
 *  consumes. Filters out empty/non-string ids. */
export function parseAnthropicModels(body: AnthropicModelsResponse): readonly string[] {
  const data = body.data ?? [];
  return data
    .slice()
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => `anthropic/${id}`);
}
