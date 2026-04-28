// #288: fetch the list of models the local Ollama install can run.
// Backed by GET /api/models which proxies Ollama's /api/tags. Used by
// the SetupForm to autocomplete model-override fields so first-time
// users don't have to memorize valid model strings.
//
// Module-level cache: the model list rarely changes during a single
// SetupForm session, so we fetch once and share across every consumer.
// A page reload re-fetches.

import { useEffect, useState } from "react";

interface ModelsState {
  models: readonly string[];
  loading: boolean;
  error: string | null;
}

interface ModelsResponse {
  models?: string[];
  error?: string;
}

let cache: ModelsState | null = null;
let inflight: Promise<ModelsState> | null = null;
const subscribers = new Set<(s: ModelsState) => void>();

function notify(state: ModelsState): void {
  cache = state;
  for (const fn of subscribers) fn(state);
}

async function fetchModels(): Promise<ModelsState> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch("/api/models");
      if (!r.ok) {
        const next: ModelsState = {
          models: [],
          loading: false,
          error: `HTTP ${r.status}`,
        };
        notify(next);
        return next;
      }
      const body = (await r.json()) as ModelsResponse;
      const next: ModelsState = {
        models: body.models ?? [],
        loading: false,
        error: body.error ?? null,
      };
      notify(next);
      return next;
    } catch (err) {
      const next: ModelsState = {
        models: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      };
      notify(next);
      return next;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useAvailableModels(): ModelsState {
  const [state, setState] = useState<ModelsState>(
    () => cache ?? { models: [], loading: true, error: null },
  );
  useEffect(() => {
    subscribers.add(setState);
    if (!cache) void fetchModels();
    return () => {
      subscribers.delete(setState);
    };
  }, []);
  return state;
}
