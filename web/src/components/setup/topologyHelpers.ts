// Topology grid helpers + topologyForPreset — extracted from TopologyGrid.tsx.

import {
  type AgentSpec,
  type Topology,
  synthesizeTopology,
} from "../../../../shared/src/topology";
import { detectProvider, type Provider } from "../../../../shared/src/providers";
import { readLastUsed } from "./topologyStorage";

export const TOPOLOGY_PROVIDER_ORDER: readonly Provider[] = [
  "ollama",
  "ollama-cloud",
  "opencode",
  "anthropic",
  "openai",
];

export const TOPOLOGY_PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama (local)",
  "ollama-cloud": "Ollama Cloud",
  opencode: "OpenCode",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function topologyProviderAvailable(
  p: Provider,
  status: {
    providers?: {
      opencode?: { available?: boolean };
      anthropic?: { available?: boolean };
      openai?: { available?: boolean };
      ollama?: { available?: boolean };
      "ollama-cloud"?: { available?: boolean };
    } | null;
  },
): boolean {
  if (p === "ollama" || p === "ollama-cloud") return true;
  if (p === "opencode") return status.providers?.opencode?.available ?? false;
  return status.providers ? (status.providers[p]?.available ?? true) : true;
}

export function agentRowProvider(agent: AgentSpec, formProvider: Provider): Provider {
  return agent.provider ?? formProvider;
}

export function modelMatchesProvider(model: string, next: Provider): boolean {
  const detected = detectProvider(model);
  if (detected === next) return true;
  return next === "ollama-cloud" && model.includes(":cloud");
}

// Convenience: build the initial topology when SetupForm picks a
// preset for the first time or the user switches presets. Phase 3
// adds a `lastUsed` opt-in that consults localStorage for the user's
// previous shape on this preset; SetupForm passes lastUsed=true on
// preset-change so switching back to a preset restores what the user
// had set up before. Fresh page-load also benefits since the
// auto-save survives reloads.
export function topologyForPreset(
  presetId: string,
  agentCount: number,
  options?: {
    dedicatedAuditor?: boolean;
    plannerModel?: string;
    workerModel?: string;
    auditorModel?: string;
    lastUsed?: boolean;
  },
): Topology {
  // Recover topology structure (roles, colors, tags, temp) from localStorage
  // but NOT model selections — models come from the current form state only.
  // The old overlay forced stale defaults (glm-5.1:cloud) onto recovered
  // topologies, silently ignoring the user's real model choice.
  if (options?.lastUsed) {
    const recovered = readLastUsed(presetId);
    if (recovered && recovered.agents.length >= 1) {
      const applyModel = (a: AgentSpec): string | undefined => {
        if (
          a.role === "planner" ||
          a.role === "orchestrator" ||
          a.role === "reducer" ||
          a.role === "judge"
        ) {
          return options?.plannerModel || undefined;
        }
        if (a.role === "auditor") {
          return options?.auditorModel || undefined;
        }
        return options?.workerModel || undefined;
      };
      return {
        agents: recovered.agents.map((a) => ({
          ...a,
          model: applyModel(a),
        })),
      };
    }
  }
  return synthesizeTopology(presetId, agentCount, options);
}
