import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_EXCERPTS = 8;
const EXCERPT_LINES = 50;

function scoreRelevance(path: string, keywords: string[]): number {
  const lower = path.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 2;
  }
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) score += 1;
  if (lower.includes("component") || lower.includes("panel")) score += 1;
  if (lower.includes("service") || lower.includes("api")) score += 1;
  if (lower.includes("config") || lower.includes("route")) score += 1;
  return score;
}

export async function gatherCodeContext(
  clonePath: string,
  directive: string | undefined,
  repoFiles: string[],
): Promise<ReadonlyArray<{ path: string; excerpt: string }>> {
  if (!directive || !clonePath || repoFiles.length === 0) return [];

  const keywords = directive
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 20);

  const scored = repoFiles
    .map((f) => ({ path: f, score: scoreRelevance(f, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EXCERPTS);

  const excerpts: Array<{ path: string; excerpt: string }> = [];
  for (const { path } of scored) {
    try {
      const content = await readFile(resolve(clonePath, path), "utf8");
      const lines = content.split("\n").slice(0, EXCERPT_LINES);
      excerpts.push({ path, excerpt: lines.join("\n") });
    } catch {
      // skip unreadable files
    }
  }
  return excerpts;
}
