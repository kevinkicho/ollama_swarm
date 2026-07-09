import { simpleGit } from "simple-git";

const DELIVERABLES_MAX = 50;

/** Parse `git diff --name-status` lines into deliverable entries. */
export function parseNameStatusDiff(
  output: string,
): Array<{ path: string; status: "created" | "modified" }> {
  const result: Array<{ path: string; status: "created" | "modified" }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (result.length >= DELIVERABLES_MAX) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab < 0) continue;
    const statusCode = trimmed.slice(0, tab).trim();
    const filePath = trimmed.slice(tab + 1).trim();
    if (!filePath || statusCode.startsWith("D")) continue;
    const status: "created" | "modified" =
      statusCode === "A" || statusCode.startsWith("A") ? "created" : "modified";
    result.push({ path: filePath, status });
  }
  return result;
}

/**
 * Collect files touched by commits during a run when porcelain is clean
 * (blackboard commits land during the run, so end-state status is often empty).
 */
export async function extractDeliverablesFromGit(
  clonePath: string,
  opts?: { runStartedAt?: number; commitCount?: number },
): Promise<Array<{ path: string; status: "created" | "modified" }> | undefined> {
  try {
    const git = simpleGit(clonePath);
    let commitLen = opts?.commitCount ?? 0;
    if (commitLen <= 0 && opts?.runStartedAt) {
      const startedAtIso = new Date(opts.runStartedAt).toISOString();
      const log = await git.log({ "--since": startedAtIso });
      commitLen = log.total;
    }
    if (commitLen <= 0) return undefined;

    const baseRef = `HEAD~${commitLen}`;
    let nameStatus: string;
    try {
      nameStatus = await git.raw(["diff", "--name-status", baseRef, "HEAD"]);
    } catch {
      return undefined;
    }
    const parsed = parseNameStatusDiff(nameStatus);
    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}