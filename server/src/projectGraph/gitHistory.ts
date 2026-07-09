import { existsSync } from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import type { GitCommitEntry, GitHistoryLayer } from "./types.js";

export const MAX_GIT_COMMITS = 80;
const GIT_LOG_TIMEOUT_MS = 30_000;

/** Parse `git log --shortstat` raw output (custom pretty format). */
export function parseGitLogRaw(raw: string): GitCommitEntry[] {
  const commits: GitCommitEntry[] = [];
  const blocks = raw.split("@@").filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const head = lines[0]?.trim() ?? "";
    const parts = head.split("|");
    if (parts.length < 4) continue;
    const [hash, message, author, date] = parts;
    if (!hash || hash.length < 8) continue;

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = line.match(
        /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
      );
      if (m) {
        filesChanged = Number.parseInt(m[1] ?? "0", 10) || 0;
        insertions = Number.parseInt(m[2] ?? "0", 10) || 0;
        deletions = Number.parseInt(m[3] ?? "0", 10) || 0;
        break;
      }
    }

    commits.push({
      hash: hash.slice(0, 12),
      message: (message ?? "").slice(0, 200),
      author: (author ?? "").slice(0, 80),
      date: date ?? "",
      filesChanged,
      insertions,
      deletions,
    });
  }
  return commits;
}

export async function buildGitHistoryLayer(clonePath: string): Promise<GitHistoryLayer | null> {
  if (!existsSync(path.join(clonePath, ".git"))) return null;
  try {
    const git = simpleGit({ baseDir: clonePath, timeout: { block: GIT_LOG_TIMEOUT_MS } });
    if (!(await git.checkIsRepo())) return null;
    const raw = await git.raw([
      "log",
      `-n`,
      String(MAX_GIT_COMMITS),
      "--pretty=format:@@%H|%s|%an|%aI",
      "--shortstat",
    ]);
    const commits = parseGitLogRaw(raw);
    if (commits.length === 0) return null;
    return { updatedAt: Date.now(), commits };
  } catch {
    return null;
  }
}