// Exploration / repo-files cache helpers extracted from BlackboardRunner.

import type { PlannerSeed } from "./prompts/planner.js";

export interface ExplorationCacheHost {
  explorationCache: import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[];
  repoFilesCache: string[];
}

export function getExplorationCache(
  host: ExplorationCacheHost,
): import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[] {
  return host.explorationCache;
}

export function setExplorationCache(
  host: ExplorationCacheHost,
  cache: import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[],
): void {
  host.explorationCache = cache;
}

export function clearExplorationCache(host: ExplorationCacheHost): void {
  host.explorationCache = [];
}

export function syncExplorationCacheFromSeed(host: ExplorationCacheHost, seed: PlannerSeed): void {
  if (seed.explorationCache?.length) {
    host.explorationCache = seed.explorationCache;
  }
  if (seed.repoFiles?.length) {
    host.repoFilesCache = [...seed.repoFiles];
  }
}

export function getRepoFiles(host: ExplorationCacheHost): readonly string[] {
  return host.repoFilesCache;
}
