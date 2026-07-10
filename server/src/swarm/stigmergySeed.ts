// Stigmergy seed message — extracted from StigmergyRunner.seed.

import type { RunConfig } from "./SwarmRunner.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

export function buildStigmergySeedMessage(opts: {
  clonePath: string;
  cfg: RunConfig;
  tree: string[];
}): { text: string; summary: TranscriptEntrySummary } {
  const { clonePath, cfg, tree } = opts;
  const text = [
    `Project clone: ${clonePath}`,
    `Repo: ${cfg.repoUrl}`,
    `Top-level entries: ${tree.join(", ") || "(empty)"}`,
    "",
    "Pattern: Stigmergy (pheromone trails). Agents pick which file to read each turn based on a shared annotation table. Untouched files attract; high-interest low-confidence files attract; well-covered files repel. The exploration is self-organizing — no central planner.",
  ].join("\n");
  return {
    text,
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
