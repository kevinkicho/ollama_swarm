// MoA clone + spawn proposer/aggregator pool — extracted from MoaRunner.loopBody.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import { resolveModelForTopologyIndex } from "@ollama-swarm/shared/modelConfig";

export interface MoaSpawnHost {
  repos: RepoService;
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  appendSystem: (text: string) => void;
  setPhase: (phase: import("../types.js").SwarmPhase) => void;
  getStopping: () => boolean;
}

export interface MoaSpawnResult {
  destPath: string;
  proposers: Agent[];
  aggregators: Agent[];
  proposerModel: string;
  aggregatorModel: string;
  heterogeneous: boolean;
}

/** Clone (if needed), spawn N proposers + K aggregators, return pools. */
export async function moaCloneAndSpawn(
  host: MoaSpawnHost,
  cfg: RunConfig,
): Promise<MoaSpawnResult | null> {
  const isRemoteClone = !!(
    cfg.repoUrl &&
    (cfg.repoUrl.startsWith("http://") || cfg.repoUrl.startsWith("https://"))
  );
  if (isRemoteClone) {
    host.setPhase("cloning");
  }
  const cloneResult = await host.repos.clone({
    url: cfg.repoUrl,
    destPath: cfg.localPath,
  });
  const { destPath } = cloneResult;
  host.emit({
    type: "clone_state",
    alreadyPresent: cloneResult.alreadyPresent,
    clonePath: destPath,
    priorCommits: cloneResult.priorCommits,
    priorChangedFiles: cloneResult.priorChangedFiles,
    priorUntrackedFiles: cloneResult.priorUntrackedFiles,
  });
  await host.repos.excludeRunnerArtifacts(destPath);
  host.appendSystem(`Cloned ${cfg.repoUrl} → ${destPath}`);
  if (host.getStopping()) return null;

  host.setPhase("spawning");
  const proposerCount = cfg.agentCount;
  const aggregatorCount = Math.max(1, Math.min(3, cfg.moaAggregatorCount ?? 1));
  const totalAgents = proposerCount + aggregatorCount;
  const proposerModels: readonly string[] =
    cfg.moaProposerModels && cfg.moaProposerModels.length > 0
      ? cfg.moaProposerModels
      : [cfg.moaProposerModel ?? cfg.model];
  const proposerModel = proposerModels[0]!;
  const aggregatorModel = cfg.moaAggregatorModel ?? cfg.model;
  const agents: Agent[] = [];
  for (let i = 1; i <= totalAgents; i++) {
    const isAggregator = i > proposerCount;
    const tierFallback = isAggregator
      ? aggregatorModel
      : proposerModels[(i - 1) % proposerModels.length]!;
    const model = resolveModelForTopologyIndex(cfg.topology, i, tierFallback);
    const agent = await host.manager.spawnAgentNoOpencode({
      cwd: destPath,
      index: i,
      model,
    });
    agents.push(agent);
    if (host.getStopping()) return null;
  }
  const proposers = agents.slice(0, proposerCount);
  const aggregators = agents.slice(proposerCount);
  const heterogeneous = proposerModel !== aggregatorModel;
  host.appendSystem(
    heterogeneous
      ? `MoA ready (heterogeneous): ${proposerCount} proposer(s) on ${proposerModel} + ${aggregatorCount} aggregator(s) on ${aggregatorModel} (${aggregators.map((a) => a.id).join(", ")})`
      : `MoA ready: ${proposerCount} proposer(s) + ${aggregatorCount} aggregator(s) (${aggregators.map((a) => a.id).join(", ")}) — single model: ${cfg.model}`,
  );
  if (proposerCount >= 2) {
    host.appendSystem(
      `[matrix #2] Designating ${proposers[proposers.length - 1]!.id} as CHALLENGER — red-team prompt to prevent consensus flattening.`,
    );
  }

  return {
    destPath,
    proposers,
    aggregators,
    proposerModel,
    aggregatorModel,
    heterogeneous,
  };
}
