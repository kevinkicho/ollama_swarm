// Phase 4 of #314: fetch available providers from GET /api/providers.
// SetupForm uses this to populate the provider dropdown and grey out
// providers whose API key isn't configured. Same shape as
// useAvailableModels — module-level cache + subscriber notifications
// so multiple consumers share one fetch.

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiFetch";

export interface ProviderStatus {
  available: boolean;
  hasKey: boolean;
}

export interface ProvidersState {
  providers: {
    ollama: ProviderStatus;
    "ollama-cloud": ProviderStatus;
    opencode: ProviderStatus;
    anthropic: ProviderStatus;
    openai: ProviderStatus;
  } | null;
  loading: boolean;
  error: string | null;
}

const DEFAULT_STATE: ProvidersState = {
  providers: null,
  loading: true,
  error: null,
};

let cache: ProvidersState | null = null;
let inflight: Promise<ProvidersState> | null = null;
const subscribers = new Set<(s: ProvidersState) => void>();

function notify(state: ProvidersState): void {
  cache = state;
  for (const fn of subscribers) fn(state);
}

async function fetchProviders(): Promise<ProvidersState> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await apiFetch("/api/providers");
      if (!r.ok) {
        const next: ProvidersState = {
          providers: null,
          loading: false,
          error: `HTTP ${r.status}`,
        };
        notify(next);
        return next;
      }
      const body = (await r.json()) as Record<string, unknown>;
      const pick = (id: keyof NonNullable<ProvidersState["providers"]>): ProviderStatus => {
        const entry = body[id] as ProviderStatus | undefined;
        return {
          available: entry?.available ?? false,
          hasKey: entry?.hasKey ?? false,
        };
      };
      const next: ProvidersState = {
        providers: {
          ollama: pick("ollama"),
          "ollama-cloud": pick("ollama-cloud"),
          opencode: pick("opencode"),
          anthropic: pick("anthropic"),
          openai: pick("openai"),
        },
        loading: false,
        error: null,
      };
      notify(next);
      return next;
    } catch (err) {
      const next: ProvidersState = {
        providers: null,
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

export function useProviders(): ProvidersState {
  const [state, setState] = useState<ProvidersState>(() => cache ?? DEFAULT_STATE);
  useEffect(() => {
    subscribers.add(setState);
    if (!cache) void fetchProviders();
    return () => {
      subscribers.delete(setState);
    };
  }, []);
  return state;
}
