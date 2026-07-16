/**
 * Council project seed system message (clone tree, directive, excerpts).
 * Extracted from CouncilRunner.seed.
 */

import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import { readDirective, buildDirectiveBlock } from "./directivePromptHelpers.js";
import { buildSeedSummary } from "./runSummary.js";
import type { TranscriptEntrySummary } from "../types.js";

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
  const tree = (await repos.listTopLevel(clonePath)).slice(0, 200);
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
    lines.push("", `README excerpt:\n${readmeExcerpt.slice(0, 3000)}`);
  }

  if (repoFiles.length > 0) {
    lines.push(
      "",
      `Project files (${repoFiles.length} total):`,
      ...repoFiles.slice(0, 100),
    );
    if (repoFiles.length > 100) {
      lines.push(`... and ${repoFiles.length - 100} more`);
    }
  }

  if (codeContextExcerpts.length > 0) {
    lines.push("", "Key file excerpts:");
    for (const { path, excerpt } of codeContextExcerpts) {
      lines.push(`--- ${path} ---`, excerpt, "---");
    }
  }

  // Prior-run approve/deny lessons so peers don't re-litigate settled fails.
  try {
    const { buildDeliberationSeed } = await import("./deliberation/deliberationSeed.js");
    const delib = await buildDeliberationSeed(clonePath);
    if (delib.text) {
      lines.push("", delib.text);
    }
  } catch {
    /* best-effort */
  }

  lines.push(
    "",
    "Use your read / grep / find tools to actually inspect this repo — start with README.md if present.",
    "When evaluating peers, prefer ```deliberate``` envelopes (approve/deny with evidence).",
  );

  return {
    text: lines.join("\n"),
    summary: buildSeedSummary(cfg.repoUrl, clonePath, tree),
  };
}
