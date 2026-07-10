// Debate-judge seed message construction — extracted from DebateJudgeRunner.seed.

import type { RunConfig } from "./SwarmRunner.js";
import type { DerivedProposition } from "./propositionDerive.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { DEFAULT_PROPOSITION } from "./debatePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

export function buildDebateSeedMessage(opts: {
  clonePath: string;
  cfg: RunConfig;
  tree: string[];
  proposition: string | undefined;
  derivedPropositionMeta: DerivedProposition | null;
}): { text: string; summary: TranscriptEntrySummary } {
  const { clonePath, cfg, tree, derivedPropositionMeta } = opts;
  const prop = opts.proposition ?? DEFAULT_PROPOSITION;
  const dirCtx = readDirective(cfg);
  const propositionSourceLines: string[] = [];
  if (dirCtx.hasDirective && derivedPropositionMeta) {
    const sourceLabel = derivedPropositionMeta.derived
      ? "auto-derived from directive"
      : "fallback (auto-derive failed)";
    propositionSourceLines.push(
      `_Proposition source: ${sourceLabel}._${derivedPropositionMeta.rationale ? ` ${derivedPropositionMeta.rationale}` : ""}`,
    );
  }
  const lines = [
    `Project clone: ${clonePath}`,
    `Repo: ${cfg.repoUrl}`,
    `Top-level entries: ${tree.join(", ") || "(empty)"}`,
    "",
    ...buildDirectiveBlock(dirCtx, {
      labelSuffix: "(the broader work this debate informs)",
      framingLines: propositionSourceLines,
    }),
    `Proposition under debate: "${prop}"`,
    "Agent 1 (PRO) argues FOR the proposition.",
    "Agent 2 (CON) argues AGAINST.",
    "Agent 3 (JUDGE) stays silent until the final round, then reads the full debate and scores.",
  ];
  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
