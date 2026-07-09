import { extractDeliverables } from "./summary.js";
import { extractDeliverablesFromGit } from "./runDeliverables.js";

export type PorcelainEntry = {
  xy: string;
  path: string;
  rawLine: string;
};

/** Extract the file path from a `git status --porcelain` line. */
export function pathFromPorcelainLine(line: string): string {
  const arrow = line.indexOf(" -> ");
  if (arrow >= 0) return line.slice(arrow + 4).trim();
  const space = line.indexOf(" ", 2);
  return space >= 0 ? line.slice(space + 1).trim() : line.slice(3).trim();
}

/** Parse porcelain into a path-keyed map (last line wins on duplicates). */
export function parsePorcelainLines(porcelain: string): Map<string, PorcelainEntry> {
  const map = new Map<string, PorcelainEntry>();
  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const path = pathFromPorcelainLine(line);
    if (!path) continue;
    map.set(path, { xy: line.slice(0, 2), path, rawLine: line });
  }
  return map;
}

/**
 * Paths whose porcelain entry is new or whose XY status changed since run start.
 * Unchanged pre-existing dirty files are excluded so resumed clones do not inflate
 * per-run `filesChanged`.
 */
export function diffPorcelain(baseline: string, current: string): {
  porcelain: string;
  changedFiles: number;
  paths: string[];
} {
  const base = parsePorcelainLines(baseline);
  const curr = parsePorcelainLines(current);
  const deltaLines: string[] = [];

  for (const entry of curr.values()) {
    const prev = base.get(entry.path);
    if (!prev) {
      deltaLines.push(entry.rawLine);
      continue;
    }
    if (prev.xy !== entry.xy) {
      deltaLines.push(entry.rawLine);
    }
  }

  return {
    porcelain: deltaLines.join("\n"),
    changedFiles: deltaLines.length,
    paths: deltaLines.map((l) => pathFromPorcelainLine(l)),
  };
}

export async function resolveRunGitMetrics(
  clonePath: string,
  opts: {
    baselinePorcelain: string;
    endPorcelain: string;
    commitCount?: number;
    runStartedAt?: number;
  },
): Promise<{
  filesChanged: number;
  finalGitStatus: string;
  deliverables: Array<{ path: string; status: "created" | "modified" }> | undefined;
}> {
  const delta = diffPorcelain(opts.baselinePorcelain, opts.endPorcelain);
  let deliverables = extractDeliverables(delta.porcelain);

  const fromCommits = await extractDeliverablesFromGit(clonePath, {
    runStartedAt: opts.runStartedAt,
    commitCount: opts.commitCount,
  });

  if (fromCommits?.length) {
    const seen = new Set(deliverables?.map((d) => d.path) ?? []);
    for (const d of fromCommits) {
      if (seen.has(d.path)) continue;
      deliverables = deliverables ?? [];
      deliverables.push(d);
      seen.add(d.path);
    }
  }

  const filesChanged = deliverables?.length ?? delta.changedFiles;

  return {
    filesChanged,
    finalGitStatus: delta.porcelain,
    deliverables,
  };
}