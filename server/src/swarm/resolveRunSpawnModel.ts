// Central spawn-time model resolution for all presets. Honors topology
// per-row provider/model (including topology-card header bulk-apply)
// with role/tier fallbacks when a row has no override.

import {
  resolveModelForTopologyIndex,
  spawnModelFallbackForIndex,
  type SpawnModelContext,
} from "@ollama-swarm/shared/modelConfig";
import type { RunConfig } from "./RunConfig.js";
import { computeDeepTopology } from "./orchestratorWorkerDeepTopology.js";

function spawnFallbackForRunConfig(cfg: RunConfig, index: number): string {
  if (cfg.preset === "orchestrator-worker-deep") {
    const topo = computeDeepTopology(cfg.agentCount);
    if (index === 1) return cfg.orchestratorModel ?? cfg.plannerModel ?? cfg.model;
    if (topo.midLeadIndices.includes(index)) {
      return cfg.midLeadModel ?? cfg.workerModel ?? cfg.model;
    }
    return cfg.workerModel ?? cfg.model;
  }
  const ctx: SpawnModelContext = {
    topology: cfg.topology,
    model: cfg.model,
    plannerModel: cfg.plannerModel,
    workerModel: cfg.workerModel,
    auditorModel: cfg.auditorModel,
    orchestratorModel: cfg.orchestratorModel,
    midLeadModel: cfg.midLeadModel,
    preset: cfg.preset,
    agentCount: cfg.agentCount,
  };
  return spawnModelFallbackForIndex(ctx, index);
}

/** Model string for spawnAgentNoOpencode at the given 1-based agent index. */
export function resolveRunSpawnModel(cfg: RunConfig, index: number): string {
  return resolveModelForTopologyIndex(cfg.topology, index, spawnFallbackForRunConfig(cfg, index));
}