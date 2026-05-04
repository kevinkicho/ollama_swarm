// R3 (2026-05-04): graceful degradation from cloud → local model.
//
// When all configured cloud providers (Anthropic, OpenAI, Ollama Cloud)
// are quota-walled, we'd rather keep working with a local Ollama model
// than die. This helper picks a sensible local fallback given:
//   - the set of locally-pulled Ollama tags (from /api/tags)
//   - an optional preferred-name list (e.g. cfg.degradationPreferred)
//   - the model that just failed (so we don't pick the same one)
//
// "Sensible" priority:
//   1. An exact match in the preferred list, if any of those are pulled.
//   2. The largest local model by parameter count we can infer from tag.
//   3. The first local tag, alphabetically.
//
// Pure: no I/O. Caller does the /api/tags fetch and passes the list.

import { detectProvider } from "../../../shared/src/providers.js";

/** True for models that consume external quota (anything not running
 *  on the user's own GPU). Includes Anthropic, OpenAI, Ollama Cloud. */
export function isCloudModel(modelString: string): boolean {
  const provider = detectProvider(modelString);
  return provider !== "ollama";
}

/** Given a quota-walled cloud model + the user's local Ollama tags,
 *  return the best local fallback. Null when no local model is
 *  available (caller must give up). */
export function pickLocalFallback(input: {
  failedModel: string;
  /** Ollama /api/tags model names (e.g. ["llama3:8b", "mistral:7b"]). */
  localTags: readonly string[];
  /** Optional ordered preference list. First match wins. */
  preferred?: readonly string[];
}): string | null {
  const { failedModel, localTags, preferred = [] } = input;
  if (localTags.length === 0) return null;
  // Filter out the failed model itself (in the unlikely case the user
  // listed a local model in their cfg AND it's also the failed one).
  const candidates = localTags.filter((t) => t !== failedModel);
  if (candidates.length === 0) return null;
  // 1. Preferred list — try each in order, first one that's pulled wins.
  for (const p of preferred) {
    if (candidates.includes(p)) return p;
  }
  // 2. Largest by inferred parameter count.
  const ranked = [...candidates].sort((a, b) => {
    const sa = inferParamSize(a);
    const sb = inferParamSize(b);
    if (sb !== sa) return sb - sa; // descending
    return a.localeCompare(b);
  });
  return ranked[0] ?? null;
}

/** Best-effort param-count parse from an Ollama tag.
 *  "llama3:8b" → 8, "qwen2.5:14b" → 14, "phi3" → 0. */
export function inferParamSize(tag: string): number {
  // Match Nb / N.5b / Nm patterns at the end; b = billions, m = millions.
  const m = tag.match(/(\d+(?:\.\d+)?)([bm])\b/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return m[2].toLowerCase() === "b" ? n : n / 1000;
}
