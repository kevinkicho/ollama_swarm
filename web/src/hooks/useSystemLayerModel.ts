// Brain / system-layer model — synced to server (PUT /api/system-layer) + localStorage cache.

import { useCallback, useEffect, useState } from "react";
import { detectProvider, type Provider } from "@ollama-swarm/shared/providers";
import { apiFetch } from "../lib/apiFetch";

const STORAGE_KEY = "ollama-swarm:system-layer-model";

const PROVIDER_DEFAULTS: Record<Provider, string> = {
  ollama: "llama3:8b",
  "ollama-cloud": "deepseek-v4-flash:cloud",
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-4o-mini",
  opencode: "opencode-go/deepseek-v4-flash",
};

export interface SystemLayerApiPayload {
  model?: string;
  activeModel?: string;
  activeProvider?: Provider;
  toolsEnabled?: boolean;
  source?: "request" | "ui" | "server_default";
  serverDefaultModel?: string;
  uiOverride?: string | null;
}

function readStoredModel(): string | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY)?.trim();
  return v || null;
}

function writeStoredModel(model: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, model);
}

async function pushModelToServer(model: string): Promise<SystemLayerApiPayload | null> {
  try {
    const r = await apiFetch("/api/system-layer", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!r.ok) return null;
    return (await r.json()) as SystemLayerApiPayload;
  } catch {
    return null;
  }
}

export interface SystemLayerModelState {
  model: string;
  provider: Provider;
  setModel: (model: string) => void;
  setProvider: (provider: Provider) => void;
  ready: boolean;
  serverDefault: string | null;
  /** Where the active Brain model came from on the server. */
  source: SystemLayerApiPayload["source"] | null;
  toolsEnabled: boolean | null;
}

export function useSystemLayerModel(): SystemLayerModelState {
  const [model, setModelState] = useState(() => readStoredModel() ?? PROVIDER_DEFAULTS["ollama-cloud"]);
  const [provider, setProviderState] = useState<Provider>(() =>
    detectProvider(readStoredModel() ?? PROVIDER_DEFAULTS["ollama-cloud"]),
  );
  const [ready, setReady] = useState(false);
  const [serverDefault, setServerDefault] = useState<string | null>(null);
  const [source, setSource] = useState<SystemLayerApiPayload["source"] | null>(null);
  const [toolsEnabled, setToolsEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/system-layer");
        if (!r.ok) return;
        const body = (await r.json()) as SystemLayerApiPayload;
        if (cancelled) return;

        if (body.serverDefaultModel) setServerDefault(body.serverDefaultModel);
        setSource(body.source ?? null);
        setToolsEnabled(body.toolsEnabled ?? null);

        const stored = readStoredModel();
        if (body.uiOverride) {
          setModelState(body.uiOverride);
          setProviderState(detectProvider(body.uiOverride));
        } else if (stored) {
          setModelState(stored);
          setProviderState(detectProvider(stored));
          void pushModelToServer(stored);
        } else if (body.activeModel) {
          setModelState(body.activeModel);
          setProviderState(detectProvider(body.activeModel));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (model) {
      const detected = detectProvider(model);
      if (detected !== provider) setProviderState(detected);
    }
  }, [model, provider]);

  const setModel = useCallback((next: string) => {
    setModelState(next);
    writeStoredModel(next);
    void pushModelToServer(next).then((body) => {
      if (!body) return;
      setSource(body.source ?? "ui");
      setToolsEnabled(body.toolsEnabled ?? null);
    });
  }, []);

  const setProvider = useCallback((next: Provider) => {
    setProviderState(next);
    const fallback = PROVIDER_DEFAULTS[next];
    setModelState(fallback);
    writeStoredModel(fallback);
    void pushModelToServer(fallback).then((body) => {
      if (!body) return;
      setSource(body.source ?? "ui");
      setToolsEnabled(body.toolsEnabled ?? null);
    });
  }, []);

  return { model, provider, setModel, setProvider, ready, serverDefault, source, toolsEnabled };
}