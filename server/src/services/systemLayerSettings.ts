// UI-selected Brain / system-layer model (persisted for the server process).

import { detectProvider, type Provider } from "@ollama-swarm/shared/providers";
import { pickBrainChatModelWithTools } from "../swarm/brainDuringRun.js";

let uiModel: string | null = null;

export function getSystemLayerUiModel(): string | null {
  return uiModel;
}

export function setSystemLayerUiModel(model: string | null): void {
  const trimmed = model?.trim();
  uiModel = trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Client request model wins; else UI setting from sidebar; else env/keys defaults. */
export function resolveSystemLayerModel(clientModel?: string): {
  modelString: string;
  toolsEnabled: boolean;
  source: "request" | "ui" | "server_default";
  provider: Provider;
} {
  const fromRequest = clientModel?.trim();
  if (fromRequest) {
    const picked = pickBrainChatModelWithTools(fromRequest);
    return {
      ...picked,
      source: "request",
      provider: detectProvider(fromRequest),
    };
  }
  if (uiModel) {
    const picked = pickBrainChatModelWithTools(uiModel);
    return {
      ...picked,
      source: "ui",
      provider: detectProvider(uiModel),
    };
  }
  const picked = pickBrainChatModelWithTools();
  return {
    ...picked,
    source: "server_default",
    provider: detectProvider(picked.modelString),
  };
}

export function getSystemLayerSettingsPayload() {
  const resolved = resolveSystemLayerModel();
  const serverDefault = pickBrainChatModelWithTools();
  return {
    model: uiModel ?? resolved.modelString,
    activeModel: resolved.modelString,
    activeProvider: resolved.provider,
    toolsEnabled: resolved.toolsEnabled,
    source: resolved.source,
    serverDefaultModel: serverDefault.modelString,
    uiOverride: uiModel,
  };
}

/** Test-only reset. */
export function __resetSystemLayerSettingsForTests(): void {
  uiModel = null;
}