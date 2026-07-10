// Orchestrator–worker seed message — extracted from OrchestratorWorkerRunner.seed.

import type { RunConfig } from "./SwarmRunner.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

export function buildOrchestratorWorkerSeedMessage(opts: {
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
        "The lead decomposes the directive into worker subtasks; workers execute in parallel toward the directive; lead synthesizes a directive answer at the end.",
      ],
    }),
    "Pattern: Orchestrator–worker. Agent 1 is the LEAD; other agents are WORKERS.",
    "Lead will produce a plan (one subtask per worker), workers will execute in parallel with no visibility of peers, then lead will synthesize.",
  ];
  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
