/**
 * Council project seed system message (clone tree, directive, excerpts).
 * Extracted from CouncilRunner.seed.
 *
 * Seed diet (run d3f56d9a): fat inventory + long excerpts were re-billed on
 * every tool turn (~5.5M prompt tokens in <4 min). Keep grounding, cap bulk.
 */

import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import { readDirective, buildDirectiveBlock } from "./directivePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

/** Max top-level tree entries in seed (was 200). */
export const COUNCIL_SEED_MAX_TOP_LEVEL = 80;
/** Max repo file paths listed (was 100). */
export const COUNCIL_SEED_MAX_REPO_FILES = 60;
/** Max README chars in seed (was 3000). */
export const COUNCIL_SEED_MAX_README_CHARS = 1_500;
/** Max chars per key-file excerpt (was unbounded join of 50 lines). */
export const COUNCIL_SEED_MAX_EXCERPT_CHARS = 800;
/** Max key-file excerpts (secondary; gatherCodeContext also caps). */
export const COUNCIL_SEED_MAX_EXCERPTS = 5;

export interface CouncilSeedInput {
  clonePath: string;
  cfg: RunConfig;
  repos: RepoService;
  repoFiles: string[];
  codeContextExcerpts: ReadonlyArray<{ path: string; excerpt: string }>;
}

export async function buildCouncilSeedMessage(
  input: CouncilSeedInput,
): Promise<{ text: string; summary: TranscriptEntrySummary }> {
  const { clonePath, cfg, repos, repoFiles, codeContextExcerpts } = input;
  const tree = (await repos.listTopLevel(clonePath)).slice(0, COUNCIL_SEED_MAX_TOP_LEVEL);
  const dirCtx = readDirective(cfg);
  const readmeExcerpt = await repos.readReadme(clonePath);

  const lines: string[] = [
    `Project clone: ${clonePath}`,
    `Repo: ${cfg.repoUrl}`,
    `Top-level entries: ${tree.join(", ") || "(empty)"}`,
    "",
    ...buildDirectiveBlock(dirCtx, {
      framingLines: [
        "Every drafter answers the directive above. Round 1 = independent drafts (peers hidden); Round 2+ = reveal and revise. Synthesis at the end consolidates into a single plan.",
      ],
      authoritative: true,
    }),
  ];

  if (readmeExcerpt) {
    lines.push(
      "",
      `README excerpt:\n${readmeExcerpt.slice(0, COUNCIL_SEED_MAX_README_CHARS)}`,
    );
  }

  if (repoFiles.length > 0) {
    const listed = repoFiles.slice(0, COUNCIL_SEED_MAX_REPO_FILES);
    lines.push(
      "",
      `Project files (${repoFiles.length} total; showing ${listed.length}):`,
      ...listed,
    );
    if (repoFiles.length > COUNCIL_SEED_MAX_REPO_FILES) {
      lines.push(`... and ${repoFiles.length - COUNCIL_SEED_MAX_REPO_FILES} more (use tools to inspect)`);
    }
  }

  if (codeContextExcerpts.length > 0) {
    lines.push("", "Key file excerpts (capped — prefer tools for full files):");
    for (const { path, excerpt } of codeContextExcerpts.slice(0, COUNCIL_SEED_MAX_EXCERPTS)) {
      const body =
        excerpt.length > COUNCIL_SEED_MAX_EXCERPT_CHARS
          ? `${excerpt.slice(0, COUNCIL_SEED_MAX_EXCERPT_CHARS)}\n…`
          : excerpt;
      lines.push(`--- ${path} ---`, body, "---");
    }
  }

  // Prior-run approve/deny lessons so peers don't re-litigate settled fails.
  try {
    const { buildDeliberationSeed } = await import("./deliberation/deliberationSeed.js");
    const delib = await buildDeliberationSeed(clonePath);
    if (delib.text) {
      lines.push("", delib.text.slice(0, 2_000));
    }
  } catch {
    /* best-effort */
  }

  lines.push(
    "",
    "Use your read / grep / list tools sparingly to verify paths — seed already has inventory + excerpts.",
    "When evaluating peers, prefer ```deliberate``` envelopes (approve/deny with evidence).",
  );

  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
