// 2026-05-03: live discovery of OpenAI models via /v1/models. Same
// shape as discoverAnthropicModels — returns prefixed ids
// ("openai/gpt-5") to match what ModelInput's <datalist> consumes.
//
// OpenAI's /v1/models returns hundreds of entries (every model + every
// historical snapshot ever released, including embedding/image/audio
// models). The form only needs CHAT models suitable for an agent —
// so we filter by id-prefix to drop the noise. Filter set is
// deliberately conservative; users with access to a model not in the
// filter can still type its id directly (free-text input always works).

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// Prefixes of model ids we surface in the autocomplete. Keeps the
// dropdown focused on chat-grade models the swarm presets actually
// run on. Embeddings, audio (whisper, tts-), image (dall-e, image-),
// fine-tunes, and dated snapshots get filtered out.
const OPENAI_CHAT_PREFIXES = ["gpt-5", "gpt-4", "o1", "o3"];

export interface OpenAIModelEntry {
  id: string;
  created?: number;
  owned_by?: string;
}

export interface OpenAIModelsResponse {
  data?: OpenAIModelEntry[];
}

/** Fetch the model list from OpenAI. Returns prefixed model ids
 *  ("openai/<id>") for chat-grade models only, sorted by created
 *  desc (newest first). Returns null on any failure — caller falls
 *  back to the hardcoded list. */
export async function discoverOpenAIModels(opts?: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<readonly string[] | null> {
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (apiKey.length === 0) return null;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  try {
    const r = await fetchImpl(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as OpenAIModelsResponse;
    return parseOpenAIModels(body);
  } catch {
    return null;
  }
}

/** Pure parser — exported for tests. Filters to chat-grade models
 *  via OPENAI_CHAT_PREFIXES, also drops dated snapshot ids
 *  (anything matching `*-YYYY-MM-DD` or `*-NNNN` suffixes) so the
 *  dropdown doesn't get cluttered with every month's snapshot.
 *  Sorts by created desc (newest first), prefixes with "openai/". */
export function parseOpenAIModels(body: OpenAIModelsResponse): readonly string[] {
  const data = body.data ?? [];
  return data
    .filter((m): m is OpenAIModelEntry => typeof m.id === "string" && m.id.length > 0)
    .filter((m) => OPENAI_CHAT_PREFIXES.some((p) => m.id.startsWith(p)))
    // Drop dated snapshots — they bloat the list without adding info
    // for the swarm's purposes (preset runners pick the alias which
    // points at the latest snapshot anyway).
    .filter((m) => !/-\d{4}-\d{2}-\d{2}$/.test(m.id))
    .filter((m) => !/-\d{4}$/.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => `openai/${m.id}`);
}
