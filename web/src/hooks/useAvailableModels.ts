// #288: fetch the list of models the local Ollama install can run.
// Backed by GET /api/models which proxies Ollama's /api/tags. Used by
// the SetupForm to autocomplete model-override fields so first-time
// users don't have to memorize valid model strings.
//
// 2026-05-03: extended to accept a `provider` arg. The server's
// /api/models route dispatches:
//   - default / "ollama":  /api/tags discovery
//   - "anthropic":         /v1/models discovery (Anthropic key required)
//   - "openai":            /v1/models discovery (OpenAI key required)
//   - "opencode":          OpenCode Go /zen/go/v1/models + Zen /zen/v1/models
// Each paid-provider response is server-side cached for 24h. On
// missing key / network error the server falls back to the hardcoded
// list in shared/providers.ts and reports `source: "fallback"`.
//
// Module-level cache keyed by provider so the hook can be called
// from many components without each refetching. A page reload
// re-fetches.

import { useEffect, useState } from "react";
import type { Provider } from "@ollama-swarm/shared/providers";
import { apiFetch } from "../lib/apiFetch";

interface ModelsState {
  models: readonly string[];
  loading: boolean;
  error: string | null;
  /** Where the list came from. "ollama-tags" for local Ollama discovery,
   *  "discovery" for live paid-provider /v1/models, "fallback" for the
   *  hardcoded shared/providers.ts list. Lets the UI render an inline
   *  hint ("using cached/fallback list") if needed. */
  source: "ollama-tags" | "discovery" | "fallback" | null;
}

interface ModelsResponse {
  models?: string[];
  source?: "ollama-tags" | "discovery" | "fallback";
  error?: string;
}

const cache = new Map<Provider, ModelsState>();
const inflight = new Map<Provider, Promise<ModelsState>>();
const subscribers = new Map<Provider, Set<(s: ModelsState) => void>>();

function notify(provider: Provider, state: ModelsState): void {
  cache.set(provider, state);
  const subs = subscribers.get(provider);
  if (subs) for (const fn of subs) fn(state);
}

async function fetchModels(provider: Provider): Promise<ModelsState> {
  const existing = inflight.get(provider);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const r = await apiFetch(`/api/models?provider=${encodeURIComponent(provider)}`);
      if (!r.ok) {
        const next: ModelsState = {
          models: [],
          loading: false,
          error: `HTTP ${r.status}`,
          source: null,
        };
        notify(provider, next);
        return next;
      }
      const body = (await r.json()) as ModelsResponse;
      const next: ModelsState = {
        models: [...new Set(body.models ?? [])],
        loading: false,
        error: body.error ?? null,
        source: body.source ?? null,
      };
      notify(provider, next);
      return next;
    } catch (err) {
      const next: ModelsState = {
        models: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        source: null,
      };
      notify(provider, next);
      return next;
    } finally {
      inflight.delete(provider);
    }
  })();
  inflight.set(provider, promise);
  return promise;
}

export function useAvailableModels(provider: Provider = "ollama"): ModelsState {
  const [state, setState] = useState<ModelsState>(
    () => cache.get(provider) ?? { models: [], loading: true, error: null, source: null },
  );
  useEffect(() => {
    let subs = subscribers.get(provider);
    if (!subs) {
      subs = new Set();
      subscribers.set(provider, subs);
    }
    subs.add(setState);
    // Initial sync to current cache state when switching providers.
    const cached = cache.get(provider);
    if (cached) {
      setState(cached);
    } else {
      setState({ models: [], loading: true, error: null, source: null });
      void fetchModels(provider);
    }
    return () => {
      subs?.delete(setState);
    };
  }, [provider]);
  return state;
}
