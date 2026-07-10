// Round-robin seed message — extracted from RoundRobinRunner.seed.

import type { RunConfig } from "./SwarmRunner.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

export function buildRoundRobinSeedMessage(opts: {
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
        "The deliberation should converge on a concrete plan / answer for the directive above. Treat it as the question every disposition is helping resolve.",
      ],
    }),
    "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
  ];
  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
