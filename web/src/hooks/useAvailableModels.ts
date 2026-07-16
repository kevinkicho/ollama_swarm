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
//
// 2026-07-16: network failures ("Failed to fetch") used to poison the
// cache forever until reload — common during tsx-watch restarts. Now
// we retry briefly, fall back to the shared catalog for non-ollama
// providers, and re-attempt failed fetches after a short TTL.

import { useEffect, useState } from "react";
import { modelsForProvider, type Provider } from "@ollama-swarm/shared/providers";
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
  /** Wall time of last settle (success or failure). Used for error retry. */
  fetchedAt?: number;
}

interface ModelsResponse {
  models?: string[];
  source?: "ollama-tags" | "discovery" | "fallback";
  error?: string;
}

/** Re-fetch failed discoveries after this window (dev server restarts). */
const ERROR_RETRY_MS = 5_000;
const NETWORK_RETRIES = 3;

const cache = new Map<Provider, ModelsState>();
const inflight = new Map<Provider, Promise<ModelsState>>();
const subscribers = new Map<Provider, Set<(s: ModelsState) => void>>();

function notify(provider: Provider, state: ModelsState): void {
  cache.set(provider, state);
  const subs = subscribers.get(provider);
  if (subs) for (const fn of subs) fn(state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function offlineCatalog(provider: Provider): readonly string[] {
  return modelsForProvider(provider);
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
    || (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message));
}

async function fetchModels(provider: Provider): Promise<ModelsState> {
  const existing = inflight.get(provider);
  if (existing) return existing;
  const promise = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < NETWORK_RETRIES; attempt++) {
      try {
        const r = await apiFetch(`/api/models?provider=${encodeURIComponent(provider)}`);
        if (!r.ok) {
          const catalog = offlineCatalog(provider);
          const next: ModelsState = {
            models: catalog.length > 0 ? [...catalog] : [],
            loading: false,
            error: catalog.length > 0
              ? `HTTP ${r.status} — using offline catalog`
              : `HTTP ${r.status}`,
            source: catalog.length > 0 ? "fallback" : null,
            fetchedAt: Date.now(),
          };
          notify(provider, next);
          return next;
        }
        const body = (await r.json()) as ModelsResponse;
        let models = [...new Set(body.models ?? [])];
        let source = body.source ?? null;
        let error = body.error ?? null;
        // Empty live list but we have a curated catalog — keep the form usable.
        if (models.length === 0) {
          const catalog = offlineCatalog(provider);
          if (catalog.length > 0) {
            models = [...catalog];
            source = "fallback";
            if (!error) error = "Empty discovery — using offline catalog";
          }
        }
        const next: ModelsState = {
          models,
          loading: false,
          error,
          source,
          fetchedAt: Date.now(),
        };
        notify(provider, next);
        return next;
      } catch (err) {
        lastErr = err;
        if (attempt < NETWORK_RETRIES - 1 && isNetworkError(err)) {
          await sleep(250 * (attempt + 1));
          continue;
        }
      }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const catalog = offlineCatalog(provider);
    const next: ModelsState = {
      models: catalog.length > 0 ? [...catalog] : [],
      loading: false,
      error: catalog.length > 0
        ? `Backend unreachable (${msg}) — using offline catalog`
        : msg,
      source: catalog.length > 0 ? "fallback" : null,
      fetchedAt: Date.now(),
    };
    notify(provider, next);
    return next;
  })();
  inflight.set(provider, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(provider);
  }
}

function shouldRefetch(cached: ModelsState | undefined): boolean {
  if (!cached) return true;
  if (cached.loading) return false;
  // Success with models: keep until reload.
  if (!cached.error && cached.models.length > 0) return false;
  // Pure success empty list (local ollama with no tags): don't hammer.
  if (!cached.error) return false;
  // Soft/hard error: retry after TTL so tsx-watch restarts recover.
  const age = Date.now() - (cached.fetchedAt ?? 0);
  return age >= ERROR_RETRY_MS;
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

    const cached = cache.get(provider);
    if (cached && !shouldRefetch(cached)) {
      setState(cached);
    } else {
      // Keep last good/fallback models visible while retrying.
      if (cached && cached.models.length > 0) {
        setState({ ...cached, loading: true });
      } else {
        setState({ models: [], loading: true, error: null, source: null });
      }
      void fetchModels(provider);
    }

    // If currently in error state, schedule one retry after TTL so a
    // recovered backend is picked up without a full page reload.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const latest = cache.get(provider);
    if (latest?.error) {
      const wait = Math.max(0, ERROR_RETRY_MS - (Date.now() - (latest.fetchedAt ?? 0)));
      timer = setTimeout(() => {
        if (shouldRefetch(cache.get(provider))) void fetchModels(provider);
      }, wait);
    }

    return () => {
      subs?.delete(setState);
      if (timer) clearTimeout(timer);
    };
  }, [provider]);
  return state;
}
