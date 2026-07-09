import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inferMarketTabFromText,
  isCreatePanelTodo,
} from "@ollama-swarm/shared/panelConvention";
import { EMIT_ONLY_PROFILE_ID, DEFAULT_WORKER_CREATE_SCAFFOLD_WALL_CLOCK_MS } from "@ollama-swarm/shared/toolProfiles";
import type { ProfileName } from "../../tools/ToolDispatcher.js";

export const CREATE_SCAFFOLD_WALL_CLOCK_MS = DEFAULT_WORKER_CREATE_SCAFFOLD_WALL_CLOCK_MS;

const SCAFFOLD_EXCERPT_MAX = 4000;

export interface WorkerScaffoldPlan {
  profile: ProfileName;
  promptWallClockMs: number;
  skipLiterature: boolean;
  scaffoldBlock?: string;
}

export function isCreateOnlyTodo(
  expectedFiles: readonly string[],
  fileContents: Record<string, string | null>,
): boolean {
  return expectedFiles.length > 0 && expectedFiles.every((f) => fileContents[f] == null);
}

/** Pick first panel under src/markets/{tab}/ from repo file list. */
export function pickExemplarFromRepoFiles(
  description: string,
  repoFiles: readonly string[],
): string | undefined {
  const tab = inferMarketTabFromText(description);
  if (!tab) return undefined;
  const prefix = `src/markets/${tab}/`;
  return repoFiles.find(
    (f) => f.replace(/\\/g, "/").startsWith(prefix) && /Panel\.(jsx|tsx)$/i.test(f),
  );
}

export async function loadScaffoldExcerpt(
  clonePath: string,
  exemplarPath: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(clonePath, exemplarPath), "utf8");
    const trimmed = raw.trim();
    return trimmed.length <= SCAFFOLD_EXCERPT_MAX
      ? trimmed
      : trimmed.slice(0, SCAFFOLD_EXCERPT_MAX - 3) + "...";
  } catch {
    return undefined;
  }
}

export function buildScaffoldPromptBlock(
  exemplarPath: string,
  excerpt: string | undefined,
): string {
  const lines = [
    "=== CREATE-SCAFFOLD MODE (emit JSON only — do NOT tour the repo) ===",
    `A sibling panel already exists at: ${exemplarPath}`,
    "Mirror its imports, hooks, BentoCard layout, and data-fetch pattern.",
    "Emit op:\"create\" hunks for missing expectedFiles only.",
    "Do NOT call read/grep/glob/list — exemplar excerpt is below.",
  ];
  if (excerpt?.trim()) {
    lines.push("", `--- exemplar: ${exemplarPath} ---`, excerpt.trim(), "--- end exemplar ---");
  }
  lines.push("=== end CREATE-SCAFFOLD MODE ===", "");
  return lines.join("\n");
}

export async function resolveWorkerScaffoldPlan(input: {
  description: string;
  expectedFiles: string[];
  fileContents: Record<string, string | null>;
  repoFiles: readonly string[];
  clonePath: string;
  createScaffoldWallClockMs?: number;
}): Promise<WorkerScaffoldPlan | undefined> {
  const allMissing = isCreateOnlyTodo(input.expectedFiles, input.fileContents);
  if (!allMissing || !isCreatePanelTodo(input.description, input.expectedFiles)) {
    return undefined;
  }
  const exemplar = pickExemplarFromRepoFiles(input.description, input.repoFiles);
  if (!exemplar) return undefined;

  const excerpt = await loadScaffoldExcerpt(input.clonePath, exemplar);
  return {
    profile: EMIT_ONLY_PROFILE_ID,
    promptWallClockMs: input.createScaffoldWallClockMs ?? CREATE_SCAFFOLD_WALL_CLOCK_MS,
    skipLiterature: true,
    scaffoldBlock: buildScaffoldPromptBlock(exemplar, excerpt),
  };
}