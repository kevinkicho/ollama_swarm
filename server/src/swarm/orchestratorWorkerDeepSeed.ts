// OW-Deep seed message — extracted from OrchestratorWorkerDeepRunner.seed.

import type { RunConfig } from "./SwarmRunner.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

export function buildOrchestratorWorkerDeepSeedMessage(opts: {
  clonePath: string;
  cfg: RunConfig;
  tree: string[];
  midLeadIndices: readonly number[];
  workerIndices: readonly number[];
}): { text: string; summary: TranscriptEntrySummary } {
  const { clonePath, cfg, tree, midLeadIndices, workerIndices } = opts;
  const dirCtx = readDirective(cfg);
  const lines = [
    `Project clone: ${clonePath}`,
    `Repo: ${cfg.repoUrl}`,
    `Top-level entries: ${tree.join(", ") || "(empty)"}`,
    "",
    ...buildDirectiveBlock(dirCtx, {
      framingLines: [
        "The orchestrator decomposes the directive into coarse questions for each mid-lead. Each mid-lead decomposes its coarse question into worker subtasks. Workers execute toward the directive. Mid-leads + orchestrator synthesize a directive answer.",
      ],
    }),
    "Pattern: 3-tier orchestrator-worker (deep).",
    `  Tier 1 — orchestrator (agent 1)`,
    `  Tier 2 — ${midLeadIndices.length} mid-leads (agents ${midLeadIndices.join(", ")})`,
    `  Tier 3 — ${workerIndices.length} workers, partitioned across mid-leads`,
    "",
    "Per cycle: orchestrator dispatches one coarse subtask per mid-lead; each mid-lead breaks its subtask into worker subtasks; workers execute in parallel; mid-leads synthesize upward; orchestrator synthesizes the cycle.",
  ];
  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
