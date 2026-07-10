// Map-reduce seed message — extracted from MapReduceRunner.seed.

import type { RunConfig } from "./SwarmRunner.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

export function buildMapReduceSeedMessage(opts: {
  clonePath: string;
  cfg: RunConfig;
  tree: string[];
}): { text: string; summary: TranscriptEntrySummary } {
  const { clonePath, cfg, tree } = opts;
  const dirCtx = readDirective(cfg);
  const lines = [
    `Project clone: ${clonePath}`,
    `Repo: ${cfg.repoUrl}`,
    `Top-level entries: ${tree.join(", ") || "(empty)"}`,
    "",
    ...buildDirectiveBlock(dirCtx, {
      framingLines: [
        "The map-reduce sweep should find everything in this repo that bears on the directive above. Mappers: report findings relevant to the directive within YOUR slice; if your slice has nothing relevant, say so explicitly — that's a valid + welcome answer. Reducer: synthesize across mappers to ANSWER the directive.",
      ],
    }),
    "Pattern: Map-reduce. Agent 1 is the REDUCER; others are MAPPERS.",
    "Each mapper inspects only its assigned slice of the repo (in isolation). The reducer consolidates all mapper reports at the end of each cycle.",
  ];
  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
